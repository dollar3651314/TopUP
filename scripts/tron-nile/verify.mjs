#!/usr/bin/env node
// TRON 合约钱包上线前的两项验证（Nile 测试网；也能对本机私链跑）。说明见同目录 README.md。
//
//   node scripts/tron-nile/verify.mjs --offline           只编译 + 离线算地址，不联网（不需要私钥）
//   node scripts/tron-nile/verify.mjs                     连 Nile（https://nile.trongrid.io）跑全部验证
//   node scripts/tron-nile/verify.mjs --node http://127.0.0.1:9090   连本机私链
//
// 私钥：优先读环境变量 TOPUP_NILE_PRIVATE_KEY（放在 GitHub 的环境密钥里）；没有就在终端里提示输入（输入时不回显）。
// 私钥只在内存里用来签名，不打印、不写文件。只准连 Nile 或本机：主网会被拒绝。
// TronGrid API Key（可选）：环境变量 TRONGRID_API_KEY。
// 结果：屏幕上一段摘要 + JSON 报告（--report 指定文件，默认 nile-report.json），里面只有公开的链上数据（地址、交易号、能量）。
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { compile } from './compile.mjs';
import { forwarderAddress, toBase58, addr20 } from './tron-create2.mjs';
import { createNode, makeSigner } from './tron-node.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OFFLINE = args.includes('--offline');
const NODE = opt('--node', 'https://nile.trongrid.io');
const REPORT = opt('--report', 'nile-report.json');
const FEE_LIMIT = 1_000_000_000; // 每笔交易最多烧 1,000 TRX（Nile 测试币；实际用量见报告里的能量）
const ONE_TRX = 1_000_000;

const out = { startedAt: new Date().toISOString(), node: OFFLINE ? null : NODE, steps: [], checks: [], energy: {} };
const log = (...a) => console.log(...a);
function check(name, pass, detail = {}) {
  out.checks.push({ name, pass: !!pass, ...detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
}
const addrFromWord = (w) => toBase58(addr20(w.slice(-40)));

async function readKey() {
  const fromEnv = process.env.TOPUP_NILE_PRIVATE_KEY;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error('没有私钥：设置环境变量 TOPUP_NILE_PRIVATE_KEY，或者在终端里直接运行本脚本');
  process.stdout.write('请输入 Nile 测试账户的私钥（64 位十六进制，输入时不显示，回车结束）：');
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(buf); return; }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function offlineSelfTest() {
  // 0x41 和 0xff 两种算法的地址必然不同；同样输入下结果稳定
  const sample = { factory: '41' + '01'.repeat(20), implementation: '41' + '02'.repeat(20), parent: '41' + '03'.repeat(20), feeAddress: '41' + '04'.repeat(20), salt: '0x' + '11'.repeat(32) };
  const a = forwarderAddress(sample);
  check('offline: 0x41 address differs from 0xff address', a.tron !== a.evmStyle, { tron: a.tron, evmStyle: a.evmStyle });
}

async function main() {
  log(`编译（TRON 官方编译器）…`);
  const { compiler, artifacts } = await compile();
  out.compiler = compiler;
  out.bytecodeSha256 = Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, v.bytecodeSha256]));
  log(`编译器 ${compiler}`);
  offlineSelfTest();
  if (OFFLINE) return;

  const node = createNode({ base: NODE, apiKey: process.env.TRONGRID_API_KEY || '' });
  const net = await node.checkNetwork();
  out.network = net.network;
  const params = Object.fromEntries(((await node.post('/wallet/getchainparameters', {})).chainParameter || []).map((x) => [x.key, x.value ?? 0]));
  out.chainParams = Object.fromEntries(['getEnergyFee', 'getCreateNewAccountFeeInSystemContract', 'getMaxFeeLimit', 'getAllowTvmConstantinople', 'getAllowTvmShangHai', 'getAllowTvmCancun', 'getAllowDynamicEnergy'].map((k) => [k, params[k] ?? null]));
  log(`链参数 ${JSON.stringify(out.chainParams)}`);
  log(`节点 ${NODE}，网络：${net.network}`);

  const signer = makeSigner(await readKey());
  const me = signer.address;
  out.account = me;
  const startBalance = await node.balance(me);
  out.startBalanceTrx = startBalance / ONE_TRX;
  log(`测试账户 ${me}，余额 ${startBalance / ONE_TRX} TRX`);
  if (startBalance < 500 * ONE_TRX) throw new Error('余额不足 500 TRX（本地私链实测整套约花 350 TRX）：先去 Nile 水龙头领测试 TRX（见 README）');

  const step = (name, r) => {
    const e = r.info?.receipt?.energy_usage_total ?? 0;
    out.energy[name] = e;
    out.steps.push({ name, txId: r.txId, energy: e, feeSun: r.info?.fee ?? 0, result: r.info?.receipt?.result ?? 'SUCCESS' });
    log(`  ${name}: ${r.txId}（能量 ${e}，烧 ${(r.info?.fee ?? 0) / ONE_TRX} TRX）`);
  };

  // 1. 部署：实现合约 → 工厂 → 小号批量合约（parent = 测试账户自己）→ 测试代币
  log('部署合约…');
  const impl = await node.deploy(signer, { name: 'ForwarderV4', ...artifacts.ForwarderV4, feeLimit: FEE_LIMIT }); step('deploy ForwarderV4', impl);
  const factory = await node.deploy(signer, { name: 'ForwarderFactoryV4', ...artifacts.ForwarderFactoryV4, params: node.enc(['address'], [impl.address]), feeLimit: FEE_LIMIT }); step('deploy ForwarderFactoryV4', factory);
  const probe = await node.deploy(signer, { name: 'NileProbe', ...artifacts.NileProbe, params: node.enc(['address', 'address'], [factory.address, me]), feeLimit: FEE_LIMIT }); step('deploy NileProbe', probe);
  const token = await node.deploy(signer, { name: 'NileTestToken', ...artifacts.NileTestToken, params: node.enc(['uint256'], [10n ** 12n]), feeLimit: FEE_LIMIT }); step('deploy NileTestToken', token);
  out.contracts = { implementation: impl.address, factory: factory.address, probe: probe.address, token: token.address, parent: me };

  const implOnChain = addrFromWord(await node.call(factory.address, 'implementationAddress()'));
  check('factory.implementationAddress() = deployed implementation', implOnChain === impl.address, { implOnChain });

  const tokenBal = async (a) => BigInt('0x' + await node.call(token.address, 'balanceOf(address)', ['address'], [a]));
  // 用合约里的 extcodesize 判断（getcontract 对合约内部创建的合约不一定返回代码）
  const codeSize = async (a) => Number(BigInt('0x' + await node.call(probe.address, 'codeSize(address)', ['address'], [a])));
  const isContract = async (a) => (await codeSize(a)) > 0;

  // 2. 每个场景一个随机盐
  async function scenario(label, { tokenFirst, trxFirst }) {
    const salt = '0x' + randomBytes(32).toString('hex');
    const s = { label, salt };
    const off = forwarderAddress({ factory: factory.address, implementation: impl.address, parent: me, feeAddress: probe.address, salt });
    s.offline41 = off.tron; s.offlineFF = off.evmStyle;
    s.contract41 = addrFromWord(await node.call(probe.address, 'forwarderAddress41(bytes32)', ['bytes32'], [salt]));
    s.contractFF = addrFromWord(await node.call(probe.address, 'forwarderAddressFF(bytes32)', ['bytes32'], [salt]));
    check(`${label}: 离线 0x41 地址 = 合约里 0x41 算出的地址`, s.offline41 === s.contract41, { offline41: s.offline41, contract41: s.contract41 });
    check(`${label}: 离线 0xff 地址 = 合约里 0xff 算出的地址（对照）`, s.offlineFF === s.contractFF);
    const target = s.offline41;
    const amount = 123_456n;
    if (tokenFirst) step(`${label}: token → address`, await node.send(signer, token.address, 'transfer(address,uint256)', ['address', 'uint256'], [target, amount], { feeLimit: FEE_LIMIT }));
    if (trxFirst) {
      const r = await node.transferTrx(signer, target, ONE_TRX); step(`${label}: 1 TRX → address (activate)`, r);
      const acc = await node.account(target);
      s.activatedBalanceSun = Number(acc.balance || 0);
      check(`${label}: 部署前地址已被激活（账户存在、余额 1 TRX、不是合约）`, !!acc.address && s.activatedBalanceSun === ONE_TRX && !(await isContract(target)), { balanceSun: s.activatedBalanceSun, type: acc.type || 'Normal' });
    }
    if (!tokenFirst) step(`${label}: token → address`, await node.send(signer, token.address, 'transfer(address,uint256)', ['address', 'uint256'], [target, amount], { feeLimit: FEE_LIMIT }));

    const parentTrxBefore = await node.balance(me);
    const created = await node.send(signer, probe.address, 'create(bytes32)', ['bytes32'], [salt], { feeLimit: FEE_LIMIT });
    step(`${label}: CREATE2 deploy`, created);
    s.createResult = created.info?.receipt?.result;
    check(`${label}: CREATE2 部署交易成功`, created.ok, { result: s.createResult, message: created.info?.resMessage ? Buffer.from(created.info.resMessage, 'hex').toString() : undefined });
    // 工厂的 ForwarderCreated 事件里有实际部署出的地址（第一个参数）
    const log0 = (created.info?.log || []).find((l) => l.address && toBase58(addr20(l.address)) === factory.address);
    s.deployedByEvent = log0 ? addrFromWord(log0.data.slice(0, 64)) : null;
    check(`${label}: 链上实际部署地址 = 离线 0x41 地址`, s.deployedByEvent === target, { deployed: s.deployedByEvent, expected: target });
    check(`${label}: 链上实际部署地址 ≠ 0xff 地址`, s.deployedByEvent !== s.offlineFF);
    check(`${label}: 该地址现在有合约代码`, await isContract(target));
    if (trxFirst) {
      const after = await node.account(target);
      s.balanceAfterDeploySun = Number(after.balance || 0);
      // parent 就是测试账户自己，它同时付了这笔部署的手续费：加回手续费后应当正好多了 1 TRX
      s.parentReceivedSun = (await node.balance(me)) - parentTrxBefore + Number(created.info?.fee ?? 0);
      check(`${label}: 激活时转入的 1 TRX 已由 init 转给 parent（地址余额 0）`, s.balanceAfterDeploySun === 0 && s.parentReceivedSun === ONE_TRX, { balanceSun: s.balanceAfterDeploySun, parentReceivedSun: s.parentReceivedSun });
    }
    const pBefore = await tokenBal(me);
    const fl = await node.send(signer, probe.address, 'flush(address,bytes32)', ['address', 'bytes32'], [token.address, salt], { feeLimit: FEE_LIMIT });
    step(`${label}: flushTokens`, fl);
    const pAfter = await tokenBal(me), fAfter = await tokenBal(target);
    check(`${label}: 归集成功，代币全部到 parent`, fl.ok && pAfter - pBefore === amount && fAfter === 0n, { parentDelta: String(pAfter - pBefore), forwarderLeft: String(fAfter) });
    // 再部署一次同一个盐必须失败（地址已有合约），确认不会"覆盖"
    // fee_limit 只给 20 TRX：CREATE2 冲突会耗光给它的能量，节点预执行时一般直接拒绝广播（不上链、不花钱）
    try {
      const again = await node.send(signer, probe.address, 'create(bytes32)', ['bytes32'], [salt], { feeLimit: 20_000_000 });
      step(`${label}: deploy same salt again (expect fail)`, again);
      check(`${label}: 同一个盐第二次部署被拒绝`, !again.ok, { result: again.info?.receipt?.result, onChain: true });
    } catch (e) {
      check(`${label}: 同一个盐第二次部署被拒绝`, /broadcast rejected|rejected/.test(e.message), { onChain: false, reason: e.message.slice(0, 160) });
    }
    return s;
  }

  log('场景 A（对照）：只转代币，不激活，再部署 …');
  const A = await scenario('A 不激活', { tokenFirst: true, trxFirst: false });
  log('场景 B：先转 1 TRX 激活，再转代币，再部署 …');
  const B = await scenario('B 先激活', { tokenFirst: false, trxFirst: true });
  log('场景 C：先转代币，再转 1 TRX 激活，再部署 …');
  const C = await scenario('C 先代币后激活', { tokenFirst: true, trxFirst: true });
  out.scenarios = [A, B, C];

  // 3. 记录 TRON 编译器对 new C{salt} 的行为（只记录，不判定通过与否）
  const salt = '0x' + randomBytes(32).toString('hex');
  const nw = await node.send(signer, probe.address, 'newWithSalt(bytes32)', ['bytes32'], [salt], { feeLimit: FEE_LIMIT });
  step('new C{salt}', nw);
  const ev = (nw.info?.log || []).find((l) => toBase58(addr20(l.address)) === probe.address && l.data?.length === 192);
  if (ev) {
    const [d, p41, pff] = [0, 1, 2].map((i) => addrFromWord(ev.data.slice(i * 64, i * 64 + 64)));
    out.newWithSalt = { deployed: d, predicted41: p41, predictedFF: pff, uses: d === p41 ? '0x41' : d === pff ? '0xff' : 'neither' };
    log(`记录：new C{salt} 实际地址 ${d}，按 ${out.newWithSalt.uses} 算出的一致`);
  } else out.newWithSalt = { error: 'event not found', ok: nw.ok };

  out.endBalanceTrx = (await node.balance(me)) / ONE_TRX;
  out.spentTrx = out.startBalanceTrx - out.endBalanceTrx;
}

main()
  .catch((e) => { out.error = e.message; console.error('ERROR', e.message); })
  .finally(() => {
    out.finishedAt = new Date().toISOString();
    out.allPass = !out.error && out.checks.length > 0 && out.checks.every((c) => c.pass);
    writeFileSync(REPORT, JSON.stringify(out, null, 2));
    log(`\n==== 结果：${out.allPass ? '全部通过' : '有失败项'}（${out.checks.filter((c) => c.pass).length}/${out.checks.length}）${out.spentTrx !== undefined ? `，花掉 ${out.spentTrx} 测试 TRX` : ''} ====`);
    log(`报告：${REPORT}（只有公开的链上数据，可以直接发回）`);
    process.exitCode = out.allPass ? 0 : 1;
  });
