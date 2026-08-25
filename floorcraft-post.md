# Floorcraft — LinkedIn post version

Decades ago, CAD software blew my mind: vector diagrams with real dimensions that never went blurry, no matter how far you zoomed.

Lately I've been working on getting AI to *understand* floor plans. Then it hit me — the fun version is the opposite.

What if I could just type:

"Create a floor plan with a kitchen and dining room, a family room and an office"

...and get a real, editable drawing? Then keep going: "increase the kitchen by 20%."

That became **Floorcraft**.

Here's the part I like most: **the AI never draws anything.**

Ask a model for coordinates and you get plausible nonsense — walls that miss each other, numbers that drift. So Floorcraft doesn't ask. The model only proposes structured edits ("add a room", "make it bigger"). A deterministic solver in your browser turns those into actual geometry.

Bad drawings become structurally impossible. Tiny models suddenly do useful work.

You can also just grab a wall and drag it. Add doors and windows. Build a second floor. Trace a scanned plan with computer vision. Export to PDF, DXF, SVG, IFC, glTF.

No signup. No API key. And if the AI is unavailable? The editor still works, completely.

The lesson isn't about floor plans. It's about giving the model the one thing it's great at — understanding what a human meant — and letting a deterministic engine be exactly right about everything else.

What would you say to your floor plan?

#GenerativeAI #CAD #ProductDesign #BuildInPublic
