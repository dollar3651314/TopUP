// 开户的邮件模板。所有邮件都是纯文本，中英双语；通知管理员的邮件不包含任何敏感字段。
// 4 个步骤；contact、rep、docs 是 的旧步骤名，只用于旧记录
export const SECTION_LABELS = {
  entity: ['Company information and documents', '企业信息和公司文件'],
  people: ['People (directors, UBOs, signatories, authorized contact) and ID documents', '人员（董事、UBO、授权签字人、授权联系人）和身份证明'],
  wallet: ['Wallet authorization', '钱包授权声明'], decl: ['Declaration and signature', '声明与签名'],
  contact: ['Company contact details', '公司联系方式'], rep: ['Authorized contact person', '授权联系人'], docs: ['Supporting documents', '证明文件'],
};
const day = (iso) => String(iso).slice(0, 10);

export function inviteEmail({ company, ref, link, expiresAt }) {
  return {
    subject: `[TopUP] Business onboarding invitation / 企业开户邀请 (${ref})`,
    text: [
      'This is a business onboarding invitation from TopUP.',
      '这是来自 TopUP 的企业开户邀请。',
      '',
      `Company / 企业: ${company}`,
      `Reference / 编号: ${ref}`,
      '',
      'Please complete your onboarding information and upload the supporting documents using your personal link below.',
      'You can save at any time and continue later using the same link.',
      '请通过下方您的专属链接填写开户资料并上传证明文件，可以随时保存，之后用同一个链接继续填写。',
      '',
      link,
      '',
      `This link is valid until ${day(expiresAt)}. / 链接有效期至 ${day(expiresAt)}。`,
      '',
      'Security notes / 安全提示:',
      '- Do not forward this link. Anyone with the link can view and edit your application.',
      '  请不要转发此链接，持有链接的人可以查看和修改您的申请。',
      '- We will never ask you to send passports or company documents by email.',
      '  我们不会要求您通过邮件发送护照或公司文件。',
      '',
      'TopUP',
    ].join('\n'),
  };
}

export function adminNotifyEmail({ company, ref, kind, adminUrl }) {
  const what = kind === 'resubmitted' ? ['resubmitted (after a request for more information)', '补件后再次提交'] : ['submitted', '已提交'];
  return {
    subject: `[TopUP] Onboarding ${kind === 'resubmitted' ? 'resubmitted' : 'submitted'}: ${ref}`,
    text: [
      `An onboarding application has been ${what[0]}.`,
      `有开户申请${what[1]}。`,
      '',
      `Reference / 编号: ${ref}`,
      `Company / 企业: ${company}`,
      '',
      `Review it in the admin console / 请在后台审核: ${adminUrl}`,
    ].join('\n'),
  };
}

export function needsInfoEmail({ company, ref, sections, message, link }) {
  const list = sections.map((s) => `- ${SECTION_LABELS[s]?.[0] || s} / ${SECTION_LABELS[s]?.[1] || s}`);
  return {
    subject: `[TopUP] Additional information needed / 需要补充资料 (${ref})`,
    text: [
      'We have reviewed your onboarding application and need some additional information.',
      '我们已审核您的开户申请，需要您补充以下资料。',
      '',
      `Company / 企业: ${company}`,
      `Reference / 编号: ${ref}`,
      '',
      'Sections to update / 需要修改的部分:',
      ...list,
      '',
      ...(message ? ['Note from our team / 说明:', message, ''] : []),
      'Please open your personal link, update the sections above and submit again:',
      '请打开您的专属链接，修改以上部分后再次提交：',
      link,
      '',
      'TopUP',
    ].join('\n'),
  };
}
