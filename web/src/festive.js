// A seasonal loading line for places where only text fits (buttons like "Saving…"),
// from einbau-festive.js. Falls back to the plain text if that script didn't load.
export function busyText(fallback) {
  try {
    const F = window.EinbauFestive;
    return (F && F.phrase && F.phrase()) || fallback;
  } catch (e) {
    return fallback;
  }
}
