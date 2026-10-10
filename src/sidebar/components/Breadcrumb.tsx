import type { HTMLAttributes, ReactNode } from 'react';
import { IconButton } from '../../ui/Button';
import { t } from '@/shared/i18n';

/**
 * 只要求 id 與標題，而不是完整的 `BookmarkFolder` —— 隱私空間的資料夾
 * （`PrivateFolder`）是另一套型別，靠這個最小形狀共用同一個麵包屑。
 */
export interface CrumbPath {
  id: string;
  title: string;
}

/** 把一段麵包屑當成拖拽的落點（拖到那一層）：要掛上去的處理器，與它現在要不要亮起來 */
export interface CrumbDrop {
  props: (folderId: string | null) => HTMLAttributes<HTMLElement>;
  className: (folderId: string | null) => string;
}

interface BreadcrumbProps {
  path: CrumbPath[];
  onNavigate: (folderId: string | null) => void;
  /** 最上層的名稱（書籤是「全部書籤」，隱私空間是「全部」） */
  rootLabel: string;
  drop?: CrumbDrop | undefined;
}

/**
 * 側邊欄的麵包屑：單行，太長時中間折成「…」。
 *
 * 只畫出最上層、上一層與目前這一層：再往上的幾層折掉（「…」回最上層、「上一層」鈕一層一層退），
 * 目前這一層的名字太長時用刪節號 —— 換到第二行會讓整個清單往下跳。
 */
export function Breadcrumb({ path, onNavigate, rootLabel, drop }: BreadcrumbProps) {
  const current = path[path.length - 1];
  if (current === undefined) {
    return (
      <nav className="crumbs" aria-label={t('crumbs_label')}>
        <span className="crumbs__current" aria-current="page">
          {rootLabel}
        </span>
      </nav>
    );
  }

  const parent = path.length >= 2 ? path[path.length - 2] : undefined;
  const crumb = (id: string | null, label: ReactNode, title: string): ReactNode => (
    <button
      type="button"
      className={`crumbs__item${drop?.className(id) ?? ''}`}
      title={title}
      {...drop?.props(id)}
      onClick={() => {
        onNavigate(id);
      }}
    >
      {label}
    </button>
  );

  return (
    <nav className="crumbs" aria-label={t('crumbs_label')}>
      {/* 有上一層可回時，最上層縮成「…」省寬度（滑鼠提示仍寫全名） */}
      {crumb(null, parent === undefined ? rootLabel : '…', rootLabel)}
      <span className="crumbs__sep">/</span>
      {parent === undefined ? null : (
        <>
          {crumb(parent.id, parent.title || t('folder_untitled'), parent.title || t('folder_untitled'))}
          <span className="crumbs__sep">/</span>
        </>
      )}
      <span className="crumbs__current" aria-current="page" title={current.title}>
        {current.title || t('folder_untitled')}
      </span>
    </nav>
  );
}

/** 「上一層」：最上層與搜尋結果沒有上一層，不傳就不畫 */
export function UpButton({ onUp }: { onUp: (() => void) | undefined }) {
  return onUp === undefined ? null : <IconButton icon="back" label={t('crumbs_up')} onClick={onUp} />;
}
