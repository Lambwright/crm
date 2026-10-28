import { useEffect, useRef } from "react";

// The suite's shared loading animation (Claude typing away, in costume for the
// season, with matching loading lines) from einbau-festive.js, loaded in
// index.html. Use it anywhere something is loading. Falls back to plain text
// if the script didn't load. Pass `text` only when the user needs specific
// information.
export default function Loading({ text, size = 140 }) {
  const ref = useRef(null);
  useEffect(() => {
    const F = window.EinbauFestive;
    if (!F || !ref.current) return undefined;
    const l = F.loader(ref.current, { size, text });
    return () => l.remove();
  }, [text, size]);
  return (
    <div ref={ref} className="empty-state">
      {text || "Loading…"}
    </div>
  );
}
