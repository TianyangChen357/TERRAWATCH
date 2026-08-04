/*
 * Runtime switch for a static TERRAWATCH build.
 *
 * Keep the checked-in default off so the public demo can still use the
 * upstream services.  The self-hosted deployment instructions replace this
 * file with deploy/terrawatch-config.self-hosted.js (and, optionally, set a
 * separate dataOrigin).
 */
window.TERRAWATCH_CONFIG = Object.assign(
  {
    selfHostedData: false,
    selfHostedTiles: false,
    dataOrigin: ""
  },
  window.TERRAWATCH_CONFIG || {}
);
