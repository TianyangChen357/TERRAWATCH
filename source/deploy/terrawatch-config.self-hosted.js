/* Copy this file over terrawatch-config.js in the deployed web root. */
window.TERRAWATCH_CONFIG = {
  selfHostedData: true,
  selfHostedTiles: true,
  // Leave empty when Nginx serves both the UI and /data/ on this same domain.
  // Example for a dedicated data host: "https://data.example.com"
  dataOrigin: ""
};
