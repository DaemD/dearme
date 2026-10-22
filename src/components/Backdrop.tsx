// Soft, slowly drifting colour behind everything. Purely decorative.
export function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="zeneb-orb zeneb-orb-a"
        style={{ left: "-10%", top: "-12%", width: 440, height: 440 }}
      />
      <div
        className="zeneb-orb zeneb-orb-b"
        style={{ right: "-12%", top: "18%", width: 400, height: 400, animationDelay: "-7s" }}
      />
      <div
        className="zeneb-orb zeneb-orb-c"
        style={{ left: "22%", bottom: "-20%", width: 480, height: 480, animationDelay: "-14s" }}
      />
    </div>
  )
}
