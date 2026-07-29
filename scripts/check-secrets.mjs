import { execFileSync } from 'node:child_process';

const scanTrackedFiles = process.argv.includes('--tracked');

const knownSecretRules = [
  ['私鑰', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Stripe secret key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
  ['含帳密的 URL', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/],
];

const credentialName = '(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|token)';
const quotedCredential = new RegExp(`["']?${credentialName}["']?\\s*[:=]\\s*(["\x27\x60])([^"\x27\x60\\r\\n]{8,})\\1`, 'i');
const envCredential = new RegExp(`^\\s*${credentialName}\\s*=\\s*([^\\s#"\x27]{8,})\\s*$`, 'i');
const allowedPlaceholder = /^(?:change-?me|dummy|example|placeholder|redacted|replace-?me|your[_-])/i;

function runGit(args) {
  return execFileSync('git', args, { encoding: 'buffer' });
}

function getPaths() {
  const args = scanTrackedFiles
    ? ['ls-files', '-z']
    : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];

  return runGit(args)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function findRule(line) {
  for (const [name, pattern] of knownSecretRules) {
    if (pattern.test(line)) {
      return name;
    }
  }

  const quotedMatch = line.match(quotedCredential);
  if (quotedMatch && !allowedPlaceholder.test(quotedMatch[2])) {
    return '硬編碼的密碼或金鑰欄位';
  }

  const envMatch = line.match(envCredential);
  if (envMatch && !allowedPlaceholder.test(envMatch[1])) {
    return '硬編碼的環境變數憑證';
  }

  return undefined;
}

const findings = [];

for (const path of getPaths()) {
  let content;
  try {
    content = runGit(['show', `:${path}`]);
  } catch {
    continue;
  }

  if (content.includes(0)) {
    continue;
  }

  const lines = content.toString('utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const rule = findRule(line);
    if (rule) {
      findings.push({ path, line: index + 1, rule });
    }
  }
}

if (findings.length > 0) {
  console.error('偵測到疑似密碼或金鑰，已中止：');
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}（${finding.rule}）`);
  }
  console.error('請移除憑證、改用環境變數，必要時撤銷並重新簽發已曝光的憑證。');
  process.exit(1);
}

const scope = scanTrackedFiles ? '目前所有追蹤檔案' : '已暫存檔案';
console.log(`${scope}未偵測到疑似密碼或金鑰。`);
