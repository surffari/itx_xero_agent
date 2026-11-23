import { readFile, writeFile } from "node:fs/promises";

export async function updateDotEnv(values: Record<string, string | undefined>, path = ".env") {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    content = "";
  }

  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const escaped = value.replaceAll('"', '\\"');
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, `${key}=${escaped}`);
    } else {
      content += `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}${key}=${escaped}\n`;
    }
  }

  await writeFile(path, content, "utf8");
}
