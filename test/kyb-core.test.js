import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKeys, encryptJson, decryptJson, newToken, hashToken } from '../server/kyb/crypto.js';
import { totpCode, verifyTotp, base32Encode, base32Decode } from '../server/kyb/totp.js';
import { hashPassword, verifyPassword, makeSession, readSession } from '../server/kyb/auth.js';
import { validateSection, validateForSubmit, upgradeToV7, mapUnlocked, keepLegacy, DOC_IDS } from '../server/kyb/schema.js';

const SECRET = 'unit-test-secret-unit-test-secret-0123456789';

test('加密：往返正确；每次密文不同；篡改后解密失败；错误密钥无法解密', () => {
  const k = deriveKeys(SECRET);
  const v = { passport: 'K1234567X', nested: [1, 2, { a: '中文' }] };
  const c1 = encryptJson(k.enc, v), c2 = encryptJson(k.enc, v);
  assert.notEqual(c1, c2);
  assert.deepEqual(decryptJson(k.enc, c1), v);
  assert.ok(!c1.includes('K1234567X'));
  const parts = c1.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decryptJson(k.enc, parts.join('.')));
  assert.throws(() => decryptJson(deriveKeys(SECRET + 'x').enc, c1));
  assert.throws(() => deriveKeys('short'));
});

test('令牌：256 位随机，哈希与密钥相关', () => {
  const k = deriveKeys(SECRET);
  const t = newToken();
  assert.ok(Buffer.from(t, 'base64url').length === 32);
  assert.equal(hashToken(k.token, t), hashToken(k.token, t));
  assert.notEqual(hashToken(k.token, t), hashToken(deriveKeys(SECRET + 'y').token, t));
});

test('TOTP：通过 RFC 6238 官方测试向量（SHA1）；允许 ±30 秒误差', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 附录 B：T=59 → 94287082，T=1111111109 → 07081804（取后 6 位）
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
  assert.equal(totpCode(secret, 20000000000_000), '353130');
  const t = 1_800_000_000_000;
  assert.ok(verifyTotp(secret, totpCode(secret, t), t));
  assert.ok(verifyTotp(secret, totpCode(secret, t - 30_000), t));
  assert.ok(!verifyTotp(secret, totpCode(secret, t - 120_000), t));
  assert.ok(!verifyTotp(secret, 'abc123', t));
});

test('密码哈希与会话：错误密码失败；会话过期、被篡改、版本变化后失效', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  const k = deriveKeys(SECRET);
  const now = 1_800_000_000_000;
  const s = makeSession(k.session, 3, now);
  assert.ok(readSession(k.session, `a=1; topup_admin=${s}`, 3, now + 1000));
  assert.equal(readSession(k.session, `topup_admin=${s}`, 3, now + 8 * 3600e3 + 1), null);
  assert.equal(readSession(k.session, `topup_admin=${s}`, 4, now), null);
  assert.equal(readSession(k.session, `topup_admin=${s.slice(0, -1)}x`, 3, now), null);
  assert.equal(readSession(k.session, 'topup_admin=garbage', 3, now), null);
});

const person = (o = {}) => ({ pid: '0', roles: ['director', 'ubo', 'contact'], fullName: 'Jane Tan', dob: '1984-02-11', nationality: 'SG', address: 'x', idType: 'passport', idNo: 'K1', idCountry: 'SG', idExpiry: '2031-05-01', ownershipPct: '100', votingPct: '100', pep: 'no', email: 'j@a.com', phone: '+65 9000 1111', ...o });

test('字段校验：草稿只拦截非法内容，提交时严格校验', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  assert.deepEqual(validateSection('entity', { legalName: '' }, { now }).errors, {});
  assert.equal(validateSection('entity', { legalName: 'A\nB' }, { now }).errors['entity.legalName'], 'invalid');
  assert.equal(validateSection('entity', { nature: ['casino'] }, { now }).errors['entity.nature'], 'invalid');
  const strict = validateSection('entity', { nature: ['other'], email: 'bad', phone: 'call me' }, { strict: true, now }).errors;
  assert.equal(strict['entity.legalName'], 'required');
  assert.equal(strict['entity.natureOther'], 'required');
  // 公司联系方式并入企业信息
  assert.equal(strict['entity.email'], 'email'); assert.equal(strict['entity.phone'], 'phone'); assert.equal(strict['entity.website'], 'required');
  for (const gone of ['lei', 'tin', 'parent']) assert.equal(validateSection('entity', { [gone]: 'x' }, { now }).data[gone], undefined, gone);
  // 旧步骤不能再单独保存
  for (const old of ['contact', 'rep', 'docs']) assert.equal(validateSection(old, {}, { now }).errors._section, 'invalid', old);
  const p = validateSection('people', [person({ idExpiry: '2026-01-01', pep: 'yes' })], { strict: true, now }).errors;
  assert.equal(p['people.0.idExpiry'], 'future');
  assert.equal(p['people.0.pepDetails'], 'required');
  assert.equal(validateSection('people', [person({ roles: ['director'] })], { strict: true, now }).errors.people, 'people');
  assert.equal(validateSection('people', [person()], { strict: true, now }).errors.people, undefined);
  assert.equal(validateSection('people', [person({ residence: 'SG' })], { now }).data[0].residence, undefined); // 居住国已删除
});

test('人员：证件类型、证件号码、签发国、到期日必填；恰好 1 位授权联系人，只有他的邮箱电话必填', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const e = validateSection('people', [person({ idType: '', idNo: '', idCountry: '', idExpiry: '' })], { strict: true, now }).errors;
  for (const k of ['idType', 'idNo', 'idCountry', 'idExpiry']) assert.equal(e[`people.0.${k}`], 'required', k);
  assert.equal(validateSection('people', [person({ idType: 'driver' })], { now }).errors['people.0.idType'], 'invalid');
  assert.deepEqual(validateSection('people', [person({ idType: 'id_card' })], { strict: true, now }).errors, {});
  const noContact = validateSection('people', [person({ roles: ['director', 'ubo'] })], { strict: true, now }).errors;
  assert.equal(noContact.people, 'people');
  const two = validateSection('people', [person(), person({ pid: '1' })], { strict: true, now }).errors;
  assert.equal(two.people, 'people');
  const contactNoMail = validateSection('people', [person({ email: '', phone: '' })], { strict: true, now }).errors;
  assert.equal(contactNoMail['people.0.email'], 'required'); assert.equal(contactNoMail['people.0.phone'], 'required');
  const other = validateSection('people', [person(), person({ pid: '1', roles: ['signatory'], email: '', phone: '' })], { strict: true, now }).errors;
  assert.deepEqual(other, {});
});

test('提交校验：每位人员必须有身份证明，公司文件选传', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const form = { people: [person(), person({ pid: '1', roles: ['signatory'] })] };
  const errs = validateForSubmit(form, [], now);
  assert.equal(errs['docs.id:0'], 'required'); assert.equal(errs['docs.id:1'], 'required');
  for (const k of ['docs.d1', 'docs.company', 'docs.walletProof', 'docs.poa:0', 'docs.passport:0']) assert.equal(errs[k], undefined, k);
  const e2 = validateForSubmit(form, [{ doc: 'id', person: '0' }, { doc: 'id', person: '1' }], now);
  assert.equal(Object.keys(e2).filter((k) => k.startsWith('docs.')).length, 0);
  assert.equal(validateForSubmit(form, [{ doc: 'id', person: '0' }, { doc: 'passport', person: '1' }], now)['docs.id:1'], 'required');
  for (const d of ['company', 'id']) assert.ok(DOC_IDS.has(d));
  for (const d of ['d1', 'd6', 'passport', 'poa', 'walletProof']) assert.ok(!DOC_IDS.has(d), d);
});

test('旧申请整理：联系方式并入企业信息；授权联系人变成人员；护照变成证件；文件归类；旧数据保留', () => {
  const legacyApp = () => ({
    form: {
      entity: { legalName: 'A', lei: 'LEI1', tin: 'T1' },
      contact: { website: 'a.example', email: 'ops@a.example', phone: '+65 1111', otherContact: 'wechat' },
      rep: { name: 'Bob Lee', email: 'bob@a.example', phone: '+65 2222' },
      people: [{ pid: '0', roles: ['director', 'ubo'], fullName: 'Jane Tan', residence: 'SG', passportNo: 'K1', passportCountry: 'SG', passportExpiry: '2031-05-01', email: 'jane@a.example' }],
      wallet: { clientName: 'A', idTypeNo: 'X', proofType: 'provider' },
    },
    files: [{ id: 'f1', doc: 'd1' }, { id: 'f2', doc: 'passport', person: '0' }, { id: 'f3', doc: 'poa', person: '0' }, { id: 'f4', doc: 'walletProof' }],
  });
  const p = legacyApp();
  assert.equal(upgradeToV7(p), true);
  assert.equal(p.form.v, 7);
  assert.deepEqual([p.form.entity.website, p.form.entity.email, p.form.entity.phone], ['a.example', 'ops@a.example', '+65 1111']);
  assert.equal(p.form.entity.lei, 'LEI1'); // 删掉的字段数据不删
  assert.equal(p.form.people.length, 2);
  const jane = p.form.people[0];
  assert.deepEqual([jane.idType, jane.idNo, jane.idCountry, jane.idExpiry, jane.passportNo], ['passport', 'K1', 'SG', '2031-05-01', 'K1']);
  assert.deepEqual(p.form.people[1], { pid: '1', roles: ['contact'], fullName: 'Bob Lee', email: 'bob@a.example', phone: '+65 2222' });
  assert.deepEqual(p.files.map((f) => f.doc), ['company', 'id', 'poa', 'walletProof']);
  assert.equal(p.files[0].legacyDoc, 'd1');
  assert.ok(p.form.contact && p.form.rep, '旧的步骤数据保留，后台照常显示');
  assert.equal(upgradeToV7(p), false); // 再整理一次不变

  // 授权联系人本来就在人员里（按邮箱或姓名识别）：只加角色，不新增人员
  for (const rep of [{ name: 'X', email: 'JANE@a.example' }, { name: ' jane tan ', email: 'other@a.example' }]) {
    const q = legacyApp(); q.form.rep = { ...rep, phone: '+65 3333' };
    upgradeToV7(q);
    assert.equal(q.form.people.length, 1);
    assert.deepEqual(q.form.people[0].roles, ['director', 'ubo', 'contact']);
    assert.equal(q.form.people[0].phone, '+65 3333');
  }
  // 补件时开放的旧步骤名换成新步骤名
  assert.deepEqual(mapUnlocked(['contact']), ['entity']);
  assert.deepEqual(mapUnlocked(['rep', 'wallet']), ['people', 'wallet']);
  assert.deepEqual(mapUnlocked(['docs']), ['entity', 'people']);
  // 保存时保留旧字段的数据（人员按 pid 对应）
  assert.deepEqual(keepLegacy('entity', { legalName: 'Old', lei: 'L' }, { legalName: 'New' }), { lei: 'L', legalName: 'New' });
  assert.deepEqual(keepLegacy('people', [{ pid: '0', residence: 'SG', fullName: 'a' }], [{ pid: '0', fullName: 'b' }, { pid: '1', fullName: 'c' }]), [{ residence: 'SG', pid: '0', fullName: 'b' }, { pid: '1', fullName: 'c' }]);
});

// ---------- 字段规则 ----------
import { validateSection as vs4 } from '../server/kyb/schema.js';
const base4 = { legalName: 'A', website: 'a.example', email: 'a@x.com', phone: '+65 1234', legalForm: 'Ltd', regNumber: '1', incDate: '2020-01-01', incPlace: 'SG', regAddress: 'a', physAddress: 'a', nature: ['export'], purpose: ['crypto', 'deposits'], volume: 'lt50k', currencies: ['usd'], markets: ['apac'], sanctions: 'no' };
const person4 = { pid: '0', roles: ['director', 'ubo', 'contact'], fullName: 'A', dob: '1980-01-01', nationality: 'SG', address: 'a', idType: 'passport', idNo: 'X', idCountry: 'SG', idExpiry: '2099-01-01', ownershipPct: '51.5', votingPct: '100', pep: 'no', email: 'a@x.com', phone: '+65 1234' };
test('企业信息：币种必填；选"其他"要注明', () => {
  assert.deepEqual(vs4('entity', base4, { strict: true }).errors, {});
  assert.equal(vs4('entity', { ...base4, currencies: [] }, { strict: true }).errors['entity.currencies'], 'required');
  assert.equal(vs4('entity', { ...base4, currencies: ['other'] }, { strict: true }).errors['entity.currenciesOther'], 'required');
  assert.equal(vs4('entity', { ...base4, currencies: ['doge'] }, { strict: true }).errors['entity.currencies'], 'invalid');
});
test('企业信息：制裁声明必填；选"是"要写说明，选"否"时说明被清空', () => {
  assert.equal(vs4('entity', { ...base4, sanctions: '' }, { strict: true }).errors['entity.sanctions'], 'required');
  assert.equal(vs4('entity', { ...base4, sanctions: 'yes' }, { strict: true }).errors['entity.sanctionsDetails'], 'required');
  assert.deepEqual(vs4('entity', { ...base4, sanctions: 'yes', sanctionsDetails: 'x' }, { strict: true }).errors, {});
  assert.equal(vs4('entity', { ...base4, sanctionsDetails: 'x' }, { strict: true }).data.sanctionsDetails, '');
});
test('企业信息：业务用途多选，兼容旧版的单选值；月交易量没有"其他"，50 万以上要写金额', () => {
  assert.deepEqual(vs4('entity', { ...base4, purpose: 'deposits' }, { strict: true }).data.purpose, ['deposits']);
  assert.equal(vs4('entity', { ...base4, purpose: ['other'] }, { strict: true }).errors['entity.purposeOther'], 'required');
  assert.equal(vs4('entity', { ...base4, volume: 'other' }, { strict: true }).errors['entity.volume'], 'invalid');
  assert.equal(vs4('entity', { ...base4, volume: 'gt500k' }, { strict: true }).errors['entity.volumeAmount'], 'required');
  assert.deepEqual(vs4('entity', { ...base4, volume: 'gt500k', volumeAmount: 'USD 1m' }, { strict: true }).errors, {});
  assert.equal(vs4('entity', { ...base4, volumeAmount: 'USD 1m' }, { strict: true }).data.volumeAmount, '');
});
test('人员：UBO 必填持股和投票权比例（0 到 100，最多 2 位小数）；不是 UBO 时不保存', () => {
  assert.deepEqual(vs4('people', [person4], { strict: true }).errors, {});
  for (const bad of ['101', '-1', 'abc', '50.123', '100.5']) assert.equal(vs4('people', [{ ...person4, ownershipPct: bad }], { strict: true }).errors['people.0.ownershipPct'], 'percent', bad);
  for (const ok of ['0', '100', '100.00', '25', '33.33']) assert.equal(vs4('people', [{ ...person4, votingPct: ok }], { strict: true }).errors['people.0.votingPct'], undefined, ok);
  assert.equal(vs4('people', [{ ...person4, votingPct: '' }], { strict: true }).errors['people.0.votingPct'], 'required');
  const notUbo = vs4('people', [{ ...person4, roles: ['director'], ownershipPct: '999' }, { ...person4, pid: '1' }], { strict: true });
  assert.equal(notUbo.data[0].ownershipPct, ''); assert.equal(notUbo.data[0].votingPct, '');
  assert.equal(notUbo.errors['people.0.ownershipPct'], undefined);
});

test('开户文件：服务器本地目录加密保存（磁盘上只有密文），读出来和原文一致；路径不能跳出目录', async () => {
  const { createLocalBlobs } = await import('../server/kyb/blobs.js');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'topup-blobs-'));
  try {
    const key = Buffer.alloc(32, 7);
    const b = createLocalBlobs(dir, { key });
    const pdf = Buffer.from('%PDF-1.4 secret passport scan');
    await b.put('kyb/a1/f1', pdf, 'application/pdf');
    assert.equal(readFileSync(join(dir, 'kyb/a1/f1')).includes(Buffer.from('passport')), false);
    assert.deepEqual(await b.head('kyb/a1/f1'), { size: pdf.length, contentType: 'application/pdf' });
    const r = await b.read('kyb/a1/f1');
    assert.equal(Buffer.from(await new Response(r.stream).arrayBuffer()).toString(), pdf.toString());
    // 换了密钥读不出来（不会返回错误的内容）
    await assert.rejects(createLocalBlobs(dir, { key: Buffer.alloc(32, 8) }).read('kyb/a1/f1'));
    await assert.rejects(b.put('../escape', pdf, 'application/pdf'), /bad pathname/);
    await b.del(['kyb/a1/f1']);
    assert.equal(await b.head('kyb/a1/f1'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
