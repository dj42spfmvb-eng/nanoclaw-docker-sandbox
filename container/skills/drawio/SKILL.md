---
name: drawio
description: Create and edit draw.io diagrams programmatically. Use for architecture diagrams, flowcharts, org charts, network diagrams, and any visual documentation. Outputs .drawio.svg files that can be opened in VS Code or draw.io Desktop.
allowed-tools: mcp__drawio__*
---

# Draw.io Diagrams

Create and edit diagrams via MCP tools. Output files are `.drawio.svg` (vector graphics with embedded diagram metadata).

## Tools

| Tool | Purpose |
|------|---------|
| `new_diagram` | Create an empty diagram file |
| `add_nodes` | Add one or more nodes (batch) |
| `link_nodes` | Connect nodes with edges (batch) |
| `edit_nodes` | Modify existing nodes or edges (batch) |
| `remove_nodes` | Delete nodes (batch) |
| `get_diagram_info` | Read diagram structure and metadata |

## Workflow

1. Create diagram: `new_diagram` with path in `/workspace/group/` (e.g., `/workspace/group/architecture.drawio.svg`)
2. Add nodes: `add_nodes` with type, label, position, dimensions
3. Link nodes: `link_nodes` with source/target IDs
4. Verify: `get_diagram_info` to check structure

## Node types

`rectangle`, `cylinder`, `cloud`, `ellipse`, `actor`, `rounded`

## Auto-layout

After adding nodes, request layout: `hierarchical`, `organic`, `circular`, `tree`

## Tips

- Always save diagrams to `/workspace/group/` so they persist
- Use batch operations — add multiple nodes in one call
- Use `get_diagram_info` to inspect existing diagrams before editing
- Node IDs returned by `add_nodes` are needed for `link_nodes` and `edit_nodes`
