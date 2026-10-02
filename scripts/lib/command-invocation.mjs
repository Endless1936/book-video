export function resolveCommandInvocation(
  command,
  args,
  { platform = process.platform, comSpec = process.env.ComSpec } = {},
) {
  if (platform === "win32" && command === "npx") {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }

  return { command, args };
}
