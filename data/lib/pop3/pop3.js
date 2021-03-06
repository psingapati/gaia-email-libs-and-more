define(['module', 'exports', 'rdcommon/log', 'net', 'crypto',
        './transport', 'mailparser/mailparser', '../mailapi/imap/imapchew',
        '../mailapi/syncbase',
        './mime_mapper', '../mailapi/allback'],
function(module, exports, log, net, crypto,
         transport, mailparser, imapchew,
         syncbase, mimeMapper, allback) {

  /**
   * The Pop3Client modules and classes are organized according to
   * their function, as follows, from low-level to high-level:
   *
   *      [Pop3Parser] parses raw protocol data from the server.
   *      [Pop3Protocol] handles the request/response semantics
   *                     along with the Request and Response classes,
   *                     which are mostly for internal use. Pop3Protocol
   *                     does not deal with I/O at all.
   *      [Pop3Client] hooks together the Protocol and a socket, and
   *                   handles high-level details like listing messages.
   *
   * In general, this tries to share as much code as possible with
   * IMAP/ActiveSync. We reuse imapchew.js to normalize POP3 MIME
   * messages in the same way as IMAP, to avoid spurious errors trying
   * to write yet another translation layer. All of the MIME parsing
   * happens in this file; transport.js contains purely wire-level
   * logic.
   *
   * Each Pop3Client is responsible for one connection only;
   * Pop3Account in GELAM is responsible for managing connection lifetime.
   *
   * As of this writing (Nov 2013), there was only one other
   * reasonably complete POP3 JavaScript implementation, available at
   * <https://github.com/ditesh/node-poplib>. It would have probably
   * worked, but since the protocol is simple, it seemed like a better
   * idea to avoid patching over Node-isms more than necessary (e.g.
   * avoiding Buffers, node socket-isms, etc.). Additionally, that
   * library only contained protocol-level details, so we would have
   * only really saved some code in transport.js.
   *
   * For error conditions, this class always normalizes errors into
   * the format as documented in the constructor below.
   * All external callbacks get passed node-style (err, ...).
   */

  function md5(s) {
    return crypto.createHash('md5').update(s).digest('hex').toLowerCase();
  }

  // Allow setTimeout and clearTimeout to be shimmed for unit tests.
  var setTimeout = window.setTimeout.bind(window);
  var clearTimeout = window.clearTimeout.bind(window);
  exports.setTimeoutFuncs = function(set, clear) {
    setTimeout = set;
    clearTimeout = clear;
  }

  /***************************************************************************
   * Pop3Client
   *
   * Connect to a POP3 server. `cb` is always invoked, with (err) if
   * the connction attempt failed. Options are as follows:
   *
   * @param {string} host
   * @param {string} username
   * @param {string} password
   * @param {string} port
   * @param {boolean|'plain'|'ssl'|'starttls'} crypto
   * @param {int} connTimeout optional connection timeout
   * @param {'apop'|'sasl'|'user-pass'} preferredAuthMethod first method to try
   * @param {boolean} debug True to dump the protocol to the console.
   *
   * The connection's current state is available at `.state`, with the
   * following values:
   *
   *   'disconnected', 'greeting', 'starttls', 'authorization', 'ready'
   *
   * All callback errors are normalized to the following form:
   *
   *    var err = {
   *      scope: 'connection|authentication|mailbox|message',
   *      name: '...',
   *      message: '...',
   *      request: Pop3Client.Request (if applicable),
   *      exception: (A socket error, if available),
   *    };
   *
   */
  var Pop3Client = exports.Pop3Client = function(options, cb) {
    // for clarity, list the available options:
    this.options = options = options || {};
    options.host = options.host || null;
    options.username = options.username || null;
    options.password = options.password || null;
    options.port = options.port || null;
    options.crypto = options.crypto || false;
    options.connTimeout = options.connTimeout || 30000;
    options.debug = options.debug || false;
    options.authMethods = ['apop', 'sasl', 'user-pass'];

    this._LOG = options._logParent ?
      LOGFAB.Pop3Client(this, options._logParent, Date.now() % 1000) : null;

    if (options.preferredAuthMethod) {
      // if we prefer a certain auth method, try that first.
      var idx = options.authMethods.indexOf(options.preferredAuthMethod);
      if (idx !== -1) {
        options.authMethods.splice(idx, 1);
      }
      options.authMethods.unshift(options.preferredAuthMethod);
    }

    // Normalize the crypto option:
    if (options.crypto === true) {
      options.crypto = 'ssl';
    } else if (!options.crypto) {
      options.crypto = 'plain';
    }

    if (!options.port) {
      options.port = {
        'plain': 110,
        'starttls': 110,
        'ssl': 995
      }[options.crypto];
      if (!options.port) {
        throw new Error('Invalid crypto option for Pop3Client: ' +
                        options.crypto);
      }
    }

    // The public state of the connection (the only one we really care
    // about is 'disconnected')
    this.state = 'disconnected';
    this.authMethod = null; // Upon successful login, the method that worked.

    // Keep track of the message IDs and UIDLs the server has reported
    // during this session (these values could change in each
    // session, though they probably won't):
    this.idToUidl = {};
    this.uidlToId = {};
    this.idToSize = {};
    // An array of {uidl: "", size: 0, number: } for each message
    // retrieved as a result of calling LIST
    this._messageList = null;
    this._greetingLine = null; // contains APOP auth info, if available

    this.protocol = new transport.Pop3Protocol();
    this.socket = net.connect(options.port, options.host,
                              options.crypto === 'ssl');

    var connectTimeout = setTimeout(function() {
      this.state = 'disconnected';
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      cb && cb({
        scope: 'connection',
        request: null,
        name: 'unresponsive-server',
        message: 'Could not connect to ' + options.host + ':' + options.port +
          ' with ' + options.crypto + ' encryption.',
      });
    }.bind(this), options.connTimeout);

    if (options.debug) {
      this.attachDebugLogging();
    }

    // Hook the protocol and socket together:
    this.socket.on('data', this.protocol.onreceive.bind(this.protocol));
    this.protocol.onsend = this.socket.write.bind(this.socket);

    this.socket.on('connect', function() {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      this.state = 'greeting';
      // No further processing is needed here. We wait for the server
      // to send a +OK greeting before we try to authenticate.
    }.bind(this));

    this.socket.on('error', function(err) {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      cb && cb({
        scope: 'connection',
        request: null,
        name: 'unresponsive-server',
        message: 'Socket exception: ' + JSON.stringify(err),
        exception: err,
      });
    }.bind(this));

    this.socket.on('close', function() {
      this.protocol.onclose();
      this.die();
    }.bind(this));

    // To track requests/responses in the presence of a server
    // greeting, store an empty request here. Our request/response
    // matching logic will pair the server's greeting with this
    // request.
    this.protocol.pendingRequests.push(
    new transport.Request(null, [], false, function(err, rsp) {
      if (err) {
        cb && cb({
          scope: 'connection',
          request: null,
          name: 'unresponsive-server',
          message: err.getStatusLine(),
          response: err,
        });
        return;
      }

      // Store the greeting line, it might be needed in authentication
      this._greetingLine = rsp.getLineAsString(0);

      this._maybeUpgradeConnection(function(err) {
        if (err) { cb && cb(err); return; }
        this._thenAuthorize(function(err) {
          if (!err) {
            this.state = 'ready';
          }
          cb && cb(err);
        });
      }.bind(this));
    }.bind(this)));
  }

  /**
   * Disconnect from the server forcibly. Do not issue a QUIT command.
   */
  Pop3Client.prototype.disconnect =
  Pop3Client.prototype.die = function() {
    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      this.socket.end();
      // No need to do anything further; we'll tear down when we
      // receive the socket's "close" event.
    }
  }

  /**
   * Attach a console logger that prints out any socket data sent or
   * received, blurring out authentication credentials. This is
   * automatically attached if {'debug': true} is passed as an option
   * to the constructor.
   */
  Pop3Client.prototype.attachDebugLogging = function() {
    // This isn't perfectly accurate; lines can split over packet/recv
    // boundaries, but it should be good enough for debug logging.
    // Because we always send a full command with the `.write()`
    // function, though, the outgoing data (thus credential hiding)
    // will always work.
    this.socket.on('data', function(data) {
      var s = bufferToPrintable(data);
      var color = (s.indexOf('-ERR') === -1 ? '\x1b[32m' : '\x1b[31m');
      dump('<-- ' + color + s + '\x1b[0;37m\n');
    });
    var oldWrite = this.socket.write;
    this.socket.write = function(data) {
      var s = bufferToPrintable(data);
      s = s.replace(/(AUTH|USER|PASS|APOP)(.*?)\\r\\n/g,
                    '$1 ***CREDENTIALS HIDDEN***\\r\\n');
      dump('--> ' + '\x1b[0;33m' + s + '\x1b[0;37m\n');
      return oldWrite.apply(this, arguments);
    }.bind(this.socket);
  }

  /**
   * Fetch the capabilities from the server. If the connection
   * supports STLS and we've specified 'starttls' as the crypto
   * option, we upgrade the connection here.
   */
  // XXX: UNUSED FOR NOW. Maybe we'll use it later.
  Pop3Client.prototype._getCapabilities = function(cb) {
    this.protocol.sendRequest('CAPA', [], true, function(err, rsp) {
      if (err) {
        // It's unlikely this server's going to do much, but we'll try.
        this.capabilities = {};
      } else {
        var lines = rsp.getDataLines();
        for (var i = 0; i < lines.length; i++) {
          var words = lines[i].split(' ');
          this.capabilities[words[0]] = words.slice(1);
        }
      }
    }.bind(this));
  }

  /**
   * If we're trying to use TLS, upgrade now.
   *
   * This is followed by ._thenAuthorize().
   */
  Pop3Client.prototype._maybeUpgradeConnection = function(cb) {
    if (this.options.crypto === 'starttls') {
      this.state = 'starttls';
      this.protocol.sendRequest('STLS', [], false, function(err, rsp) {
        if (err) {
          cb && cb({
            scope: 'connection',
            request: err.request,
            name: 'bad-security',
            message: err.getStatusLine(),
            response: err,
          });
          return;
        }
        this.socket.upgradeToSecure();
        cb();
      }.bind(this));
    } else {
      cb();
    }
  }

  /**
   * Set the current state to 'authorization' and attempts to
   * authenticate the user with any available authentication method.
   * We try APOP first if the server supports it, since we can avoid
   * replay attacks and authenticate in one roundtrip. Otherwise, we
   * try SASL AUTH PLAIN, which POP3 servers are (in theory) required
   * to support if they support SASL at all. Lastly, we fall back to
   * plain-old USER/PASS authentication if that's all we have left.
   *
   * Presently, if one authentication method fails for any reason, we
   * simply try the next. We could be smarter and drop out on
   * detecting a bad-user-or-pass error.
   */
  Pop3Client.prototype._thenAuthorize = function(cb) {
    this.state = 'authorization';

    this.authMethod = this.options.authMethods.shift();

    var user = this.options.username;
    var pass = this.options.password;
    var secret;
    switch(this.authMethod) {
    case 'apop':
      var match = /<.*?>/.exec(this._greetingLine || "");
      var apopTimestamp = match && match[0];
      if (!apopTimestamp) {
        // if the server doesn't support APOP, try the next method.
        this._thenAuthorize(cb);
      } else {
        secret = md5(apopTimestamp + pass);
        this.protocol.sendRequest(
          'APOP', [user, secret], false, function(err, rsp) {
          if (err) {
            this._greetingLine = null; // try without APOP
            this._thenAuthorize(cb);
          } else {
            cb(); // ready!
          }
        }.bind(this));
      }
      break;
    case 'sasl':
      secret = btoa(user + '\x00' + user + '\x00' + pass);
      this.protocol.sendRequest(
        'AUTH', ['PLAIN', secret], false, function(err, rsp) {
        if (err) {
          this._thenAuthorize(cb);
        } else {
          cb(); // ready!
        }
      }.bind(this));
      break;
    case 'user-pass':
    default:
      this.protocol.sendRequest('USER', [user], false, function(err, rsp) {
        if (err) {
          cb && cb({
            scope: 'authentication',
            request: err.request,
            name: 'bad-user-or-pass',
            message: err.getStatusLine(),
            response: err,
          });
          return;
        }
        this.protocol.sendRequest('PASS', [pass], false, function(err, rsp) {
          if (err) {
            cb && cb({
              scope: 'authentication',
              request: err.request,
              name: 'bad-user-or-pass',
              message: err.getStatusLine(),
              response: err,
            });
            return;
          }
          cb();
        }.bind(this));
      }.bind(this));
      break;
    }
  }

  /*********************************************************************
   * MESSAGE FETCHING
   *
   * POP3 does not support granular partial retrieval; we can only
   * download a given number of _lines_ of the message (including
   * headers). Thus, in order to download snippets of messages (rather
   * than just the entire body), we have to guess at how many lines
   * it'll take to get enough MIME data to be able to parse out a
   * text/plain snippet.
   *
   * For now, we'll try to download a few KB of the message, which
   * should give plenty of data to form a snippet. We're aiming for a
   * sweet spot, because if the message is small enough, we can just
   * download the whole thing and be done.
   */

  /**
   * Issue a QUIT command to the server, persisting any DELE message
   * deletions you've enqueued. This also closes the connection.
   */
  Pop3Client.prototype.quit = function(cb) {
    this.state = 'disconnected';
    this.protocol.sendRequest('QUIT', [], false, function(err, rsp) {
      this.disconnect();
      if (err) {
        cb && cb({
          scope: 'mailbox',
          request: err.request,
          name: 'server-problem',
          message: err.getStatusLine(),
          response: err,
        });
      } else {
        cb && cb();
      }
    }.bind(this));
  }

  /**
   * Load a mapping of server message numbers to UIDLs, so that we
   * can interact with messages stably across sessions. Additionally,
   * this fetches a LIST of the messages so that we have a list of
   * message sizes in addition to their UIDLs.
   */
  Pop3Client.prototype._loadMessageList = function(cb) {
    // if we've already loaded IDs this session, we don't need to
    // compute them again, because POP3 shows a frozen state of your
    // mailbox until you disconnect.
    if (this._messageList) {
      cb(null, this._messageList);
      return;
    }
    // First, get UIDLs for each message.
    this.protocol.sendRequest('UIDL', [], true, function(err, rsp) {
      if (err) {
        cb && cb({
          scope: 'mailbox',
          request: err.request,
          name: 'server-problem',
          message: err.getStatusLine(),
          response: err,
        });
        return;
      }

      var lines = rsp.getDataLines();
      for (var i = 0; i < lines.length; i++) {
        var words = lines[i].split(' ');
        var number = words[0];
        var uidl = words[1];
        this.idToUidl[number] = uidl;
        this.uidlToId[uidl] = number
      }
      // because POP3 servers process requests serially, the next LIST
      // will not run until after this completes.
    }.bind(this));

    // Then, get a list of messages so that we can track their size.
    this.protocol.sendRequest('LIST', [], true, function(err, rsp) {
      if (err) {
        cb && cb({
          scope: 'mailbox',
          request: err.request,
          name: 'server-problem',
          message: err.getStatusLine(),
          response: err,
        });
        return;
      }

      var lines = rsp.getDataLines();
      var allMessages = [];
      for (var i = 0; i < lines.length; i++) {
        var words = lines[i].split(' ');
        var number = words[0];
        var size = parseInt(words[1], 10);
        this.idToSize[number] = size;
        // Push the message onto the front, so that the last line
        // becomes the first message in allMessages. Most POP3 servers
        // seem to return messages in ascending date order, so we want
        // to process the newest messages first. (Tested with Dovecot,
        // Gmail, and AOL.) The resulting list here contains the most
        // recent message first.
        allMessages.unshift({
          uidl: this.idToUidl[number],
          size: size,
          number: number
        });
      }

      this._messageList = allMessages;
      cb && cb(null, allMessages);
    }.bind(this));
  }

  /**
   * Fetch the headers and snippets for all messages. Only retrieves
   * messages for which filterFunc(uidl) returns true.
   *
   * @param {object} opts
   * @param {function(uidl)} opts.filter Only store messages matching filter
   * @param {function(evt)} opts.progress Progress callback
   * @param {int} opts.checkpointInterval Call `checkpoint` every N messages
   * @param {int} opts.maxMessages Download _at most_ this many
   *   messages during this listMessages invocation. If we find that
   *   we would have to download more than this many messages, mark
   *   the rest as "overflow" messages that could be downloaded in a
   *   future sync iteration. (Default is infinite.)
   * @param {function(next)} opts.checkpoint Callback to periodically save state
   * @param {function(err, numSynced, overflowMessages)} cb
   *   Upon completion, returns the following data:
   *
   *   numSynced: The number of messages synced.
   *
   *   overflowMessages: An array of objects with the following structure:
   *
   *       { uidl: "", size: 0 }
   *
   *     Each message in overflowMessages was NOT downloaded. Instead,
   *     you should store those UIDLs for future retrieval as part of
   *     a "Download More Messages" operation.
   */
  Pop3Client.prototype.listMessages = function(opts, cb) {
    var filterFunc = opts.filter;
    var progressCb = opts.progress;
    var checkpointInterval = opts.checkpointInterval || null;
    var maxMessages = opts.maxMessages || Infinity;
    var checkpoint = opts.checkpoint;
    var overflowMessages = [];

    // Get a mapping of number->UIDL.
    this._loadMessageList(function(err, unfilteredMessages) {
      if (err) { cb && cb(err); return; }

      // Calculate which messages we would need to download.
      var totalBytes = 0;
      var bytesFetched = 0;
      var messages = [];
      var seenCount = 0;
      // Filter out unwanted messages.
      for (var i = 0; i < unfilteredMessages.length; i++) {
        var msgInfo = unfilteredMessages[i];
        if (!filterFunc || filterFunc(msgInfo.uidl)) {
          if (messages.length < maxMessages) {
            totalBytes += msgInfo.size;
            messages.push(msgInfo);
          } else {
            overflowMessages.push(msgInfo);
          }
        } else {
          seenCount++;
        }
      }

      console.log('POP3: listMessages found ' +
                  messages.length + ' new, ' +
                  overflowMessages.length + ' overflow, and ' +
                  seenCount + ' seen messages. New UIDLs:');

      messages.forEach(function(m) {
        console.log('POP3: ' + m.size + ' bytes: ' + m.uidl);
      });

      var totalMessages = messages.length;
      // If we don't provide a checkpoint interval, just do all
      // messages at once.
      if (!checkpointInterval) {
        checkpointInterval = totalMessages;
      }

      // Download all of the messages in batches.
      var nextBatch = function() {
        console.log('POP3: Next batch. Messages left: ' + messages.length);
        // If there are no more messages, we're done.
        if (!messages.length) {
          console.log('POP3: Sync complete. ' +
                      totalMessages + ' messages synced, ' +
                      overflowMessages.length + ' overflow messages.');
          cb && cb(null, totalMessages, overflowMessages);
          return;
        }

        var batch = messages.splice(0, checkpointInterval);
        var latch = allback.latch();

        // Trigger a download for every message in the batch.
        batch.forEach(function(m, idx) {
          var messageDone = latch.defer();
          this.downloadPartialMessageByNumber(m.number, function(err, msg) {
            bytesFetched += m.size;
            progressCb && progressCb({
              totalBytes: totalBytes,
              bytesFetched: bytesFetched,
              size: m.size,
              message: msg
            });
            messageDone(err);
          });
        }.bind(this));

        // When all messages in this batch have completed, trigger the
        // next batch to begin download. If `checkpoint` is provided,
        // we'll wait for it to tell us to continue (so that we can
        // save the database periodically or perform other
        // housekeeping during sync).
        latch.then(function(results) {
          console.log('POP3: Checkpoint.');
          if (checkpoint) {
            checkpoint(nextBatch);
          } else {
            nextBatch();
          }
        });
      }.bind(this);

      // Kick it off, maestro.
      nextBatch();

    }.bind(this));
  }

  /**
   * Retrieve the full body (+ attachments) of a message given a UIDL.
   *
   * @param {string} uidl The message's UIDL as reported by the server.
   */
  Pop3Client.prototype.downloadMessageByUidl = function(uidl, cb) {
    this._loadMessageList(function(err) {
      if (err) {
        cb && cb(err);
      } else {
        this.downloadMessageByNumber(this.uidlToId[uidl], cb);
      }
    }.bind(this));
  }

  /**
   * Retrieve a portion of one message. The returned message is
   * normalized to the format needed by GELAM according to
   * `parseMime`.
   *
   * @param {string} number The message number (on the server)
   * @param {function(err, msg)} cb
   */
  // XXX: TODO: There are some roundtrips between strings and buffers
  // here. This is generally safe (converting to and from UTF-8), but
  // it creates unnecessary garbage. Clean this up when we switch over
  // to jsmime.
  Pop3Client.prototype.downloadPartialMessageByNumber = function(number, cb) {
    // Based on SNIPPET_SIZE_GOAL, calculate approximately how many
    // lines we'll need to fetch in order to roughly retrieve
    // SNIPPET_SIZE_GOAL bytes.
    var numLines = Math.floor(syncbase.POP3_SNIPPET_SIZE_GOAL / 80);
    this.protocol.sendRequest('TOP', [number, numLines],
                              true, function(err, rsp) {
      if(err) {
        cb && cb({
          scope: 'message',
          request: err.request,
          name: 'server-problem',
          message: err.getStatusLine(),
          response: err,
        });
        return;
      }

      var fullSize = this.idToSize[number];
      var data = rsp.getDataAsString();
      var isSnippet = (!fullSize || data.length < fullSize);
      // If we didn't get enough data, msg.body.bodyReps may be empty.
      // The values we use for retrieving snippets are
      // sufficiently large that we really shouldn't run into this
      // case in nearly all cases. We assume that the UI will
      // handle this (exceptional) case reasonably.
      cb(null, this.parseMime(data, isSnippet, number));
    }.bind(this));
  }

  /**
   * Retrieve a message in its entirety, given a server-centric number.
   *
   * @param {string} number The message number (on the server)
   * @param {function(err, msg)} cb
   */
  Pop3Client.prototype.downloadMessageByNumber = function(number, cb) {
    this.protocol.sendRequest('RETR', [number], true, function(err, rsp) {
      if(err) {
        cb && cb({
          scope: 'message',
          request: err.request,
          name: 'server-problem',
          message: err.getStatusLine(),
          response: err,
        });
        return;
      }
      cb(null, this.parseMime(rsp.getDataAsString(), false, number));
    }.bind(this));
  }

  /**
   * Convert a MailParser-intermediate MIME tree to a structure
   * format as parsable with imapchew. This allows us to reuse much of
   * the parsing code and maintain parity between IMAP and POP3.
   */
  function mimeTreeToStructure(node, partId, partMap, partialNode) {
    var structure = [];
    var contentType = node.meta.contentType.split('/');
    var typeInfo = {};
    typeInfo.type = contentType[0];
    typeInfo.subtype = contentType[1];
    typeInfo.params = {};
    typeInfo.params.boundary = node.meta.mimeBoundary || null;
    typeInfo.params.format = node.meta.textFormat || null;
    typeInfo.params.charset = node.meta.charset || null;
    typeInfo.params.name = node.meta.fileName || null;
    if (node.meta.contentDisposition) {
      typeInfo.disposition = {
        type: node.meta.contentDisposition,
        params: {},
      };
      if (node.meta.fileName) {
        typeInfo.disposition.params.filename = node.meta.fileName;
      }
    }
    typeInfo.partID = partId || '1';
    typeInfo.id = node.meta.contentId;
    typeInfo.encoding = 'binary'; // we already decoded it
    typeInfo.size = node.content && node.content.length || 0;
    typeInfo.description = null; // unsupported (unnecessary)
    typeInfo.lines = null; // unsupported (unnecessary)
    typeInfo.md5 = null; // unsupported (unnecessary)

    // XXX: see ActiveSync Folder._updateBody. Unit tests get angry if
    // there's a trailing newline in a body part.
    if (node.content != null) {
      if (typeInfo.type === 'text' &&
          node.content.length &&
          node.content[node.content.length - 1] === '\n') {
        node.content = node.content.slice(0, -1);
        typeInfo.size--;
      }
      partMap[typeInfo.partID] = node.content;
      // If this node was only partially downloaded, note it as such
      // in a special key on partMap. We'll use this key to later
      // indicate that this part's size should be calculated based on
      // the bytes we have not downloaded yet.
      if (partialNode === node) {
        partMap['partial'] = typeInfo.partID;
      }
    }

    structure.push(typeInfo);
    if (node.childNodes.length) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var child = node.childNodes[i];
        structure.push(mimeTreeToStructure(
          child, typeInfo.partID + '.' + (i + 1), partMap, partialNode));
      }
    }
    return structure;
  }

  // This function is made visible for test logic external to this module.
  Pop3Client.parseMime = function(content) {
    return Pop3Client.prototype.parseMime.call(this, content);
  }

  Pop3Client.prototype.parseMime = function(mimeContent, isSnippet, number) {
    var mp = new mailparser.MailParser();
    mp._write(mimeContent);
    mp._process(true);
    var rootNode = mp.mimeTree;
    var partialNode = (isSnippet ? mp._currentNode : null);
    var estSize = number && this.idToSize[number] || mimeContent.length;
    var content;

    var partMap = {}; // partId -> content
    var msg = {
      id: number && this.idToUidl[number], // the server-given ID
      msg: rootNode,
      date: rootNode.meta.date && rootNode.meta.date.valueOf(),
      flags: [],
      structure: mimeTreeToStructure(rootNode, '1', partMap, partialNode),
    };

    var rep = imapchew.chewHeaderAndBodyStructure(msg, null, null);
    var bodyRepIdx = imapchew.selectSnippetBodyRep(rep.header, rep.bodyInfo);

    // Calculate the proper size for all of the parts. Any part we've
    // seen will have been fully downloaded, so we have the whole
    // thing. We must just attribute the rest of the size to the one
    // unfinished part, whose partId is stored in partMap['partial'].
    var partSizes = {};
    var usedSize = 0;
    var partialPartKey = partMap['partial'];
    for (var k in partMap) {
      if (k === 'partial') { continue; };
      if (k !== partialPartKey) {
        usedSize += partMap[k].length;
        partSizes[k] = partMap[k].length;
      }
    }
    if (partialPartKey) {
      partSizes[partialPartKey] = estSize - usedSize;
    }

    for (var i = 0; i < rep.bodyInfo.bodyReps.length; i++) {
      var bodyRep = rep.bodyInfo.bodyReps[i];
      content = partMap[bodyRep.part];
      if (content != null) {
        var req = {
          // If bytes is null, imapchew.updateMessageWithFetch knows
          // that we've fetched the entire thing. Passing in [-1, -1] as a
          // range tells imapchew that we're not done downloading it yet.
          bytes: (partialPartKey === bodyRep.part ? [-1, -1] : null),
          bodyRepIndex: i,
          createSnippet: i === bodyRepIdx,
        };
        bodyRep.size = partSizes[bodyRep.part];
        var res = {bytesFetched: content.length, text: content};
        imapchew.updateMessageWithFetch(
          rep.header, rep.bodyInfo, req, res, this._LOG);
      }
    }


    // Convert attachments and related parts to Blobs if we've
    // downloaded the whole thing:

    for (var i = 0; i < rep.bodyInfo.relatedParts.length; i++) {
      var relatedPart = rep.bodyInfo.relatedParts[i];
      relatedPart.sizeEstimate = partSizes[relatedPart.part];
      content = partMap[relatedPart.part];
      if (content != null && partialPartKey !== relatedPart.part) {
        relatedPart.file = new Blob([content], {type: relatedPart.type});
      }
    }

    for (var i = 0; i < rep.bodyInfo.attachments.length; i++) {
      var att = rep.bodyInfo.attachments[i];
      content = partMap[att.part];
      att.sizeEstimate = partSizes[att.part];
      if (content != null && partialPartKey !== att.part &&
          mimeMapper.isSupportedType(att.type)) {
        att.file = new Blob([content], {type: att.type});
      }
    }

    // If it's a snippet and we aren't sure that we have attachments,
    // guess based on what we know.
    if (isSnippet &&
        !rep.header.hasAttachments &&
        (rootNode.parsedHeaders['x-ms-has-attach'] ||
         rootNode.meta.mimeMultipart === 'mixed' ||
         estSize > syncbase.POP3_INFER_ATTACHMENTS_SIZE)) {
      rep.header.hasAttachments = true;
    }

    // If we haven't downloaded the entire message, we need to have
    // some way to tell the UI that we actually haven't downloaded all
    // of the bodyReps yet. We add this fake bodyRep here, indicating
    // that it isn't fully downloaded, so that when the user triggers
    // downloadBodyReps, we actually try to fetch the message. In
    // POP3, we _don't_ know that we have all bodyReps until we've
    // downloaded the whole thing. There could be parts hidden in the
    // data we haven't downloaded yet.
    rep.bodyInfo.bodyReps.push({
      type: 'fake', // not 'text' nor 'html', so it won't be rendered
      part: 'fake',
      sizeEstimate: 0,
      amountDownloaded: 0,
      isDownloaded: !isSnippet,
      content: null,
      size: 0,
    });

    // POP3 can't display the completely-downloaded-body until we've
    // downloaded the entire message, including attachments. So
    // unfortunately, no matter how much we've already downloaded, if
    // we haven't downloaded the whole thing, we can't start from the
    // middle.
    rep.header.bytesToDownloadForBodyDisplay = (isSnippet ? estSize : 0);

    // to fill: suid, id
    return rep;
  }

  /**
   * Display a buffer in a debug-friendly printable format, with
   * CRLFs escaped for easy protocol verification.
   */
  function bufferToPrintable(line) {
    var s = '';
    if (Array.isArray(line)) {
      line.forEach(function(l) {
        s += bufferToPrintable(l) + '\n';
      });
      return s;
    }
    for (var i = 0; i < line.length; i++) {
      var c = String.fromCharCode(line[i]);
      if (c === '\r') { s += '\\r'; }
      else if (c === '\n') { s += '\\n'; }
      else { s += c; }
    }
    return s;
  }

var LOGFAB = exports.LOGFAB = log.register(module, {
  Pop3Client: {
    type: log.CONNECTION,
    subtype: log.CLIENT,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      htmlParseError: { ex: log.EXCEPTION },
      htmlSnippetError: { ex: log.EXCEPTION },
      textChewError: { ex: log.EXCEPTION },
      textSnippetError: { ex: log.EXCEPTION },
    },
    asyncJobs: {
    },
  },
}); // end LOGFAB

Pop3Client._LOG = LOGFAB.Pop3Client();

}); // end define
