# Floorcraft MCP — LinkedIn post version

## The post

Floorcraft could always turn a sentence into a real floor plan.

The unsolved part was never the drawing. It was: **whose model?**

In the browser I shipped four answers.

→ A model running *inside Chrome itself* — free, private, offline, and small.
→ A free hosted pool — capped, shared, fine for a few turns.
→ Bring your own key — OpenRouter, Anthropic, OpenAI, Google.

Every tier trades something. The on-device model is free but literal. The great models cost money — mine or yours. And pasting an API key is friction most people never push through.

Then the obvious thing hit me.

Everyone willing to bring a key **already pays for an assistant.** And that assistant already speaks MCP.

So I stopped trying to bring a model to my app, and shipped my app to their model.

The Floorcraft MCP server exposes the plan engine as tools: create_plan, apply_patch, validate_plan, render_svg, export_plan.

And it runs **no model at all.** Zero inference. Zero tokens on my bill.

The agent does the fuzzy part — turning *"a two-bed cottage, kitchen facing the street, bath off the hallway"* into a structured room programme. The server does the exact part: geometry, constraints, validation, export to SVG, DXF, IFC.

What came back was better than any tier I'd built:

✅ Frontier-model reasoning, funded by the user's existing subscription
✅ Messy paragraphs turned into coherent, correct tool calls
✅ Noticeably higher-quality plans than my own prompt loop produced
✅ And it lives *next to their other tools* — read the brief from a doc, build the plan, drop it in the email, all in one thread

Same document. Same solver. Two front doors.

It takes about 30 seconds to connect your own agent to it — setup steps in the first comment. 👇

The lesson I keep relearning: **the cheapest model is the one your user already pays for.**

What would you connect your agent to?

#MCP #GenerativeAI #BuildInPublic #CAD #AIAgents

---

## First comment (post this yourself, right after publishing)

Connect it in 30 seconds:

Claude web or desktop → Settings → Connectors → Add custom connector, and paste:
https://floorcraft.troche.workers.dev/mcp

Claude Code (or any MCP client configured by file):
claude mcp add --transport http floorcraft https://floorcraft.troche.workers.dev/mcp

Then just ask for a floor plan.

That's anonymous mode — full building, editing and export, nothing stored. To work on a saved plan instead, open it in the web app, hit Share, and append the edit link's token to the connector URL as ?t=<token>. Every edit the agent makes then shows up live in your browser tab.
