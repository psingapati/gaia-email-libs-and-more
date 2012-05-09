({
  baseUrl: "../",
  optimize: "none", //"uglify",
  paths: {
    "almond": "deps/almond",

    "q": "data/lib/q",
    "text": "data/lib/text",
    // silly shim
    "event-queue": "data/lib/js-shims/event-queue",
    "microtime": "data/lib/js-shims/microtime",
    "path": "data/lib/js-shims/path",

    "imap": "data/lib/imap",

    "rdplat": "data/lib/rdplat",
    "rdcommon": "data/lib/rdcommon",
    "rdimap": "data/lib/rdimap",

    "buffer": "data/lib/node-buffer",
    "crypto": "data/lib/node-crypto",
    "iconv": "data/lib/js-shims/faux-iconv",
    "iconv-lite": "data/libs/js-shims/faux-iconx",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    "mimelib": "data/deps/mimelib",
    "mailparser": "data/deps/mailparser/lib",
  },
  include: ["event-queue", "deps/stringencoding/encoding.js", "rdimap/imapclient/same-frame-setup"],
  name: "almond",
  out: "../gaia-email-opt.js",
  wrap: {
    startFile: "optStart.frag",
    endFile: "optEnd.frag"
  }
})