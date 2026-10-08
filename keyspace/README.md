# Keyspace Walk

A 3D map of how big common address spaces are. One address is one square foot.

Open `index.html` in a browser. It loads Three.js from a CDN, so you need a network connection. There is no build step.

## The idea

Each address space is laid out as a flat, near-square grid. Address `i` sits at column `i mod width` and row `i div width`. A person (1.75 m) stands on the grid for scale. As you zoom out, larger reference models appear: a room, a city block, Manhattan, Colorado, Earth, the Sun, the solar system, the Milky Way, the Local Group, superclusters, and the observable universe.

| Space | Addresses | Side of the square |
|---|---|---|
| 4-digit PIN | 10^4 | 100 ft |
| US phone number | 10^10 | 19 mi |
| IPv4 | 2^32 | 12.4 mi |
| MAC address | 2^48 | 3,200 mi |
| 64-bit integer | 2^64 | 3.4 × the Earth–Moon distance |
| UUID v4 | 2^122 | 74 light-years |
| IPv6 | 2^128 | 595 light-years |
| Bitcoin address (HASH160) | 2^160 | 39 million light-years |
| Bitcoin private key (secp256k1) | ≈ 2^256 | 1.2 × 10^11 observable universes |

## Controls

- Drag: move.
- Right-drag or Shift-drag: turn and tilt.
- Scroll or pinch: zoom.
- WASD or arrow keys: walk. Hold Shift to go faster. Q and E turn.
- Click a square: pick it. Double-click: walk there.
- Type an address and press Go: fly to its square. Random picks a square for you.
- Click a name on the scale ladder: zoom to that scale.

The private key space does not accept typed input. Never paste a real private key into a web page.

## How it works

- The camera target is stored as a `BigInt` foot coordinate plus a fraction. This keeps every square exact, even 10^38 ft from the origin.
- Each frame, the scene is rebuilt in "view units", where one unit is the camera distance. This keeps GPU float math stable from 2 ft to 10^39 ft.
- One shader draws the grid. Grid lines come in levels of base^k feet: base 16 for binary spaces and base 10 for decimal spaces. Each major line is one more digit of the column or row.
- Reference models stay near "home". When you fly to a new address, they move to the landing site, so you always have a scale reference. The room stays at home.
