import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

// Windows DPAPI protects saved tokens/settings with the signed-in Windows user.
async function dpapi(input, decrypt = false) {
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $o=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.on("error", () => reject(new Error("Protected storage unavailable")));
    child.on("exit", code => code === 0 ? resolve(Buffer.from(output.trim(), "base64")) : reject(new Error("Protected storage unavailable")));
    child.stdin.end(Buffer.from(input).toString("base64"));
  });
}

export class Store {
  constructor(dir = process.env.JOYFUL_DATA_DIR || join(homedir(), ".joyful-lineworks-ai")) { this.dir = dir; }
  async read(name, fallback = null) {
    try {
      const text = await readFile(join(this.dir, `${name}.json`), "utf8");
      const record = JSON.parse(text);
      if (record.dpapi) return JSON.parse((await dpapi(Buffer.from(record.dpapi, "base64"), true)).toString("utf8"));
      return record;
    }
    catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
  }
  async write(name, data) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, `${name}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    const text = JSON.stringify(data);
    const protectedText = process.platform === "win32" ? JSON.stringify({ dpapi: (await dpapi(text)).toString("base64") }) : text;
    await writeFile(temp, protectedText, { mode: 0o600 });
    await rename(temp, target);
  }
}
