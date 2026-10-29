// Caminho: src/utils/profileUtils.ts

export interface GlobalOrContactUser {
  id?: string;
  username?: string;
  handle?: string;
  page_name?: string;
  full_name?: string;
  email?: string;
  savedName?: string;
  avatar_url?: string | null;
  status?: string;
}

/**
 * Transforma o nome do Google ou e-mail num @arroba limpo
 * Exemplo: "Silvia Agua Mineral" -> "silvia_agua_mineral"
 */
export function generateCleanHandle(rawText?: string | null, fallbackEmail?: string | null): string {
  const cleanRaw = rawText && rawText !== 'undefined' ? rawText.trim() : '';
  const emailPrefix = fallbackEmail ? fallbackEmail.split('@')[0] : '';
  const source = cleanRaw || emailPrefix || 'usuario';

  const formatted = source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')     // Substitui espaços e símbolos por _
    .replace(/_+/g, '_')             // Remove múltiplos _ seguidos
    .replace(/^_|_$/g, '');          // Remove _ no início ou no fim

  return formatted || 'usuario';
}

/**
 * Devolve SEMPRE um @arroba válido para a Página Global (nunca devolve @undefined)
 */
export function getPublicHandle(user?: GlobalOrContactUser | null): string {
  if (!user) return '@usuario';

  const rawHandle =
    user.handle && user.handle !== 'undefined'
      ? user.handle
      : user.username && user.username !== 'undefined'
      ? user.username
      : user.full_name && user.full_name !== 'undefined'
      ? user.full_name
      : user.email?.split('@')[0];

  return `@${generateCleanHandle(rawHandle, user.email)}`;
}

/**
 * Regra de Arquitetura:
 * - Aba 'contacts': Exibe o nome personalizado que você salvou na sua agenda (savedName).
 * - Aba 'global': Exibe SEMPRE o nome público original da Página Global.
 */
export function getDisplayNameByTab(
  user?: GlobalOrContactUser | null,
  activeTab: string = 'global'
): string {
  if (!user) return 'Utilizador';

  if (activeTab === 'contacts') {
    return user.savedName || user.page_name || user.username || user.full_name || 'Contacto';
  }

  // Na aba Global, ignora totalmente o savedName privado da agenda
  return (
    (user.page_name && user.page_name !== 'undefined' ? user.page_name : null) ||
    (user.username && user.username !== 'undefined' ? user.username : null) ||
    (user.full_name && user.full_name !== 'undefined' ? user.full_name : null) ||
    user.email?.split('@')[0] ||
    'Página Global'
  );
}