export function passwordChangeValidation(current: string, next: string, confirmation: string): string {
  if (!current || current.length > 128) return '请填写当前密码。';
  if (next.length < 12 || next.length > 128) return '新密码须为12至128个字符。';
  if (next !== confirmation) return '两次新密码不一致，请重新确认。';
  if (current === next) return '新密码不能与当前密码相同。';
  return '';
}

/** Do not display raw authentication responses, which may contain internal details. */
export function passwordChangeError(status: number, code?: string): string {
  if (status === 429) return '尝试次数较多，请稍后再试。';
  if (status === 401) return '登录已失效，请重新登录后修改。';
  if (status === 403) return '请求未通过验证，请刷新页面后重试。';
  if (code === 'INVALID_PASSWORD' || code === 'INVALID_PASSWORD_HASH') return '当前密码不正确，请重新输入。';
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return '新密码须为12至128个字符。';
  if (status >= 500) return '未能确认修改结果，请尝试用新密码重新登录；仍无法登录时使用原密码。';
  return '密码未能修改，请检查输入或稍后重试。';
}
