import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const revision = '0f168b31584435515ce05824b9539597aa1eec4a';
const gatewayHash = 'dce5593a7c06ca6b74c3f7b6614b42e18c09ba0a9c46d2902f6d9fde592d9cfa';
const marker = '  bot.use(messageFilter({ skipSelfEcho: false }));';
const here = dirname(fileURLToPath(import.meta.url));

// Offline source preparation only: no download, install, login, build or server start.
export async function prepareSource(root, apply = false) {
  root = resolve(root);
  const file = join(root, 'src/gateway/middleware-setup.ts');
  const source = await readFile(file, 'utf8');
  const bootstrapFile = join(root, 'src/gateway/bootstrap.ts');
  const bootstrap = await readFile(bootstrapFile, 'utf8');
  const indexFile = join(root, 'src/index.ts');
  const index = await readFile(indexFile, 'utf8');
  const pairingFile = join(root, 'src/client/qq-pairing.ts');
  const pairing = await readFile(pairingFile, 'utf8');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@tencent-connect/dsh-qqbot' || pkg.version !== '0.5.5' ||
      pkg.dependencies?.['@tencent-connect/qqbot-nodejs'] !== '^1.0.5' ||
      createHash('sha256').update(source).digest('hex') !== gatewayHash ||
      createHash('sha256').update(bootstrap).digest('hex') !== '9afbc91d2712bf0f9afec3f6c91fab85625f67894b76e73b2f966154d701cb50' ||
      createHash('sha256').update(index).digest('hex') !== '047c8d3cb19431d914acce0d4174edd21ef044410a65567721ba9f953f9fdfc5' ||
      createHash('sha256').update(pairing).digest('hex') !== 'd62cc25fa9d340bb665c591846cc5761578fe2deecb978382db0d46b477307cf' ||
      source.split(marker).length !== 2) throw new Error('upstream baseline mismatch; review before adapting');
  const destination = join(root, 'src/dafeiyu');
  try { await access(destination); throw new Error('adapter destination already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const adapter = await readFile(join(here, 'src/adapter.ts'), 'utf8');
  const textChat = await readFile(join(here, 'src/text-chat.ts'), 'utf8');
  const enrollment = await readFile(join(here, 'src/enrollment.ts'), 'utf8');
  const preview = await readFile(join(here, 'src/preview.ts'), 'utf8');
  if (!apply) return { version: pkg.version, revision, mode: 'check' };
  // Only a fresh group invitation may run before the gate; upstream pairing,
  // command-owner grants, public slash commands and host agents remain blocked.
  const patched = "import { createGroupEnrollment } from '../dafeiyu/enrollment.ts';\nimport { createDafeiyuPreview } from '../dafeiyu/preview.ts';\n" +
    source.replace('  logger: Logger,\n): void', "  logger: Logger,\n  chat?: import('../dafeiyu/adapter.ts').Options['chat'],\n): void")
      .replace(marker, marker + '\n  bot.use(createGroupEnrollment(config.appId, manager.accountAccess));\n  bot.use(createDafeiyuPreview(config.appId, chat, manager.accountAccess));');
  const patchedBootstrap = "import { installOfficialJoin } from '../dafeiyu/join.ts';\nimport { createTextChat } from '../dafeiyu/text-chat.ts';\n" + bootstrap.replace(
    '  setupMiddlewares(bot, config, manager, logger);',
    "  const chat = config.provider === 'deepseek-official' && config.model\n    ? createTextChat({ stream: options => ctx.llm.stream(options) }, { model: config.model })\n    : undefined;\n  setupMiddlewares(bot, config, manager, logger, chat);\n  installOfficialJoin(bot, config.appId, manager.accountAccess);")
    .replace("    transport: 'websocket',", "    transport: 'websocket',\n    intents: (1 << 25) | (1 << 26) | (process.env.DAFEIYU_OFFICIAL_JOIN_EVENTS === '1' ? (1 << 24) : 0),");
  await mkdir(destination);
  for (const file of ['hub.ts', 'join.ts', 'replies.ts', 'site.ts']) await writeFile(join(destination, file), await readFile(join(here, 'src', file), 'utf8'));
  await writeFile(join(destination, 'adapter.ts'), adapter);
  await writeFile(join(destination, 'preview.ts'), preview);
  await writeFile(join(destination, 'text-chat.ts'), textChat);
  await writeFile(join(destination, 'enrollment.ts'), enrollment);
  await writeFile(file, patched);
  await writeFile(bootstrapFile, patchedBootstrap);
  await writeFile(indexFile, index.replace("export const inject = ['agents'];", "export const inject = ['agents', 'llm'];"));
  await writeFile(pairingFile, pairing
    .replace('在需要添加的群里 @机器人后发送此码，有效期内可连续添加多个群。',
      '仅在目标测试群里 @机器人后发送此码。每张码只登记一个群，登记成功后立即失效；不会绑定站内账号或发放赠金。')
    .replace("'已结束，请重新生成'", "(purpose === 'allow-group' ? '已结束，请查看群名单确认登记结果' : '已结束，请重新生成')")
    .replace("'等待认领，成功结果会显示在这里。'", "(purpose === 'allow-group' ? '收到机器人登记确认后，点击完成，在群白名单查看结果。登记不代表业务功能已开启。' : '等待认领，成功结果会显示在这里。')"));
  return { version: pkg.version, revision, mode: 'hub-capable-default-closed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, flag] = process.argv.slice(2);
  if (!root || !['--check', '--apply'].includes(flag)) {
    console.error('Usage: node prepare-source.mjs <disposable local upstream checkout> --check|--apply');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await prepareSource(root, flag === '--apply'))); }
    catch { console.error('Source preparation refused: baseline mismatch, existing adapter, or file error.'); process.exitCode = 1; }
  }
}
