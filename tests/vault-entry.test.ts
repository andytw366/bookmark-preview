import { describe, expect, it } from 'vitest';
import { DEFAULT_VAULT_TRIGGER, matchesVaultTrigger } from '@/shared/vault-entry';

/**
 * 隱私空間入口的觸發字串比對。
 *
 * 重點在幾個容易寫錯的邊界：完全相等（而不是開頭符合）、大小寫不寬鬆、
 * 以及空字串必須視為停用 —— 那三個只要有一個弄反，一般搜尋就會意外
 * 把密碼畫面叫出來。
 */
describe('隱私空間的觸發字串', () => {
  it('完全相等才觸發', () => {
    expect(matchesVaultTrigger('###', '###')).toBe(true);
  });

  it('前後空白不影響（順手打到空格不該讓它失效）', () => {
    expect(matchesVaultTrigger('  ###  ', '###')).toBe(true);
    expect(matchesVaultTrigger('###', '  ###  ')).toBe(true);
  });

  it('只是開頭符合不觸發，否則打較長的搜尋會在中途跳出畫面', () => {
    expect(matchesVaultTrigger('###abc', '###')).toBe(false);
    expect(matchesVaultTrigger('##', '###')).toBe(false);
  });

  it('大小寫不做寬鬆比對 —— 觸發字串可能被設成一般單字', () => {
    expect(matchesVaultTrigger('Secret', 'secret')).toBe(false);
    expect(matchesVaultTrigger('secret', 'secret')).toBe(true);
  });

  it('觸發字串為空視為停用，任何輸入都不觸發', () => {
    expect(matchesVaultTrigger('', '')).toBe(false);
    expect(matchesVaultTrigger('   ', '   ')).toBe(false);
    expect(matchesVaultTrigger('anything', '')).toBe(false);
  });

  it('可自訂成任意字串，不限符號', () => {
    expect(matchesVaultTrigger('開門', '開門')).toBe(true);
    expect(matchesVaultTrigger('open sesame', 'open sesame')).toBe(true);
  });

  it('預設觸發字串是 ###', () => {
    expect(DEFAULT_VAULT_TRIGGER).toBe('###');
  });
});
