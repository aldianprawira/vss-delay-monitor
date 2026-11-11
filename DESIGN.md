# VSS Monitoring — Design Direction (`DESIGN.md`)

## Design Read
Reading this as: IT Operations fleet telemetry and delay monitoring dashboard for NOC and infrastructure engineers, in a precision industrial-telemetry visual language, dial `ENERGY 2 / RHYTHM 2 / MOTION 1`.

## Liveliness Dials
- **ENERGY: 2 (Balanced)** — Crisp high-contrast operational surfaces, bold tabular KPI metrics, and clear status semantics that surface fleet anomalies immediately without visual clutter.
- **RHYTHM: 2 (Consistent with purposeful breaks)** — Structured operational flow: focal KPI strip with semantic emphasis on critical health counters, paired distribution/trend charts, and dense filterable telemetry tables.
- **MOTION: 1 (Hover and state transitions only)** — Instantaneous response for keyboard/pointer states (`150ms` ease) and active query spinners, with zero decorative loops and full `prefers-reduced-motion: reduce` support.

## Liveliness Levers
- **One focal point per screen:** The primary anomaly/health KPI strip at the top of each view (`Total offline` / `Total devices delay > 5s` / `Latest delay`) carries semantic accent framing so engineers spot fleet degradation within one second.
- **Hierarchical contrast:** Fluid typographic scale (`clamp()`) pairs geometric UI headers (`Plus Jakarta Sans`) with tabular monospace identifiers and counters (`JetBrains Mono`).
- **Whitespace as structure:** A 4px/8px spatial scale separates global navigation, sticky operational topbar, KPI summary strips, analytical charts, and high-density event tables.
- **One deliberate accent:** Cobalt Telemetry Blue (`#1d4ed8` in Light, `#2563eb` in Dark) is reserved for active navigation, primary action buttons, and high-visibility keyboard focus rings.
- **Identity motif:** Precision telemetry framing — crisp `1px` structural borders, semantic status pills with high-contrast foreground/background tokens, and `tabular-nums` monospace alignment across all timestamps, device IDs, and delay measurements.

## One-Line Decision Log (R-31)
- **Color Palette:** Restricted to 3 core slate/surface neutrals plus 1 Cobalt Blue accent (`#1d4ed8`) and semantic status tokens (`ok` emerald, `warn` amber, `err` crimson) so status alerts stand out immediately and every text pairing exceeds 5.1:1 WCAG AA contrast in both Light and Dark themes.
- **Theme Toggle (Light & Dark Mode):** Ships a persistent Light/Dark mode switch in the topbar because IT Operations teams use this dashboard across both bright office monitors and dim 24/7 NOC walls.
- **Typography:** Uses `Plus Jakarta Sans` for scannable UI labels/headings and `JetBrains Mono` (`tabular-nums`) for device IDs, timestamps, and live-updating numeric counters so digits never jitter during 5-second polling.
- **Layout & Breakpoints:** Uses a 3-stage responsive layout (Desktop sidebar + multi-column grid > `1024px`, Tablet compact grid `640px–1024px`, Mobile stacked layout `< 640px` with 44px touch targets) so every viewport width reflows cleanly without horizontal overflow.
- **Elevation & Shadows:** Keeps data cards flat with crisp `1px` borders while reserving drop shadows for floating or interactive layers (the sticky topbar, Time Range Picker popover, and hoverable navigation cards).
- **Card Hierarchy:** Differentiates primary anomaly KPI cards (`variant="alert"` / `variant="warn"` / `variant="primary"`) with subtle top-border accents and stronger typographic weight so critical fleet metrics do not blend into secondary cards.
- **Icons:** Uses inline monochrome SVG icons (`aria-hidden="true"`) inside the Time Range Picker and theme toggle to ensure crisp rendering across Windows, macOS, and Linux without OS-emoji inconsistency.
