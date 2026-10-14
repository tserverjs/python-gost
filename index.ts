import {existsSync, writeFileSync, unlinkSync} from "node:fs";
import {resolve} from "node:path";
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
    
    console.log("🔍 正在获取核心组件版本信息...");
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
    if (!dlUrl) {
        console.error("❌ 未找到匹配的 Linux 架构安装包");
        process.exit(1);
    }

    console.log(`⬇️ 正在下载核心组件: ${assetFilename}`);
    const r = await fetch(dlUrl);
    const buffer = await r.arrayBuffer();
    await Bun.write(assetFilename, buffer);
    return assetFilename;
}

async function unpackBinary(archivePath: string): Promise<string> {
    console.log("📦 正在解压并配置核心组件...");
    await $`tar -xzf ${archivePath}`;
    
    const findProc = await $`find . -name "gost" -type f`.text();
    const files = findProc.trim().split("\n").filter(Boolean);
    if (files.length === 0) {
        console.error("❌ 解压后未找到目标二进制文件");
        process.exit(1);
    }

    const gostPath = files[0];
    const targetBin = resolve(".sys_worker");
    
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

    console.log(`🚀 启动核心服务 (端口: ${SERVICE_PORT})`);
    console.log(`✅ 节点链接: ${endpointLink}`);

    // 使用绝对路径，并修复了前面漏掉的 $ 符号
    const absoluteBinPath = resolve(binPath);
    const cmd = [absoluteBinPath, "-L", `socks5+wss://:${SERVICE_PORT}/?path=${ROUTE_PATH}&host=${TARGET_HOST}`];

    try {
        const proc = Bun.spawn(cmd, {
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
        });

        // 启动后删除本地二进制文件（文件已被内存加载，不影响运行）
        if (existsSync(absoluteBinPath)) {
            unlinkSync(absoluteBinPath);
            console.log("🗑️ 已清理本地二进制文件痕迹");
        }

        await proc.exited;
    } catch (e) {
        console.error("❌ 核心服务运行异常:", e);
    }
}

async function main() {
    let binPath = resolve(".sys_worker");
    if (!existsSync(binPath)) {
        const archive = await fetchCore();
        binPath = await unpackBinary(archive);
    }
    await bootWorker(binPath);
}

main();
