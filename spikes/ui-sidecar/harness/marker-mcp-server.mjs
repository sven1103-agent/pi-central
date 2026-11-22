let buffer = "";
const TOOL_NAME = "probe_marker_tool";
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    if (message.method === "initialize") {
      reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-marker", version: "0" },
      });
    } else if (message.method === "tools/list") {
      reply({ tools: [{ name: TOOL_NAME, description: "a marker", inputSchema: { type: "object" } }] });
    } else if (message.id !== undefined) {
      reply({});
    }
  }
});
