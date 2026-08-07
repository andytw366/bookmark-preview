/**
 * 只要求 id 與標題，而不是完整的 `BookmarkFolder` —— 隱私空間的資料夾
 * （`PrivateFolder`）是另一套型別，靠這個最小形狀共用同一個麵包屑。
 */
export interface CrumbPath {
  id: string;
  title: string;
}

interface BreadcrumbProps {
  path: CrumbPath[];
  onNavigate: (folderId: string | null) => void;
}

/**
 * 窄欄用麵包屑，而非縮排樹狀清單 —— 側邊欄典型寬度只有 320–420px，
 * 放不下多層縮排。路徑過長時只保留最後兩層並以「…」代表被折疊的中間層。
 */
export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  if (path.length === 0) {
    return null;
  }

  const collapsed = path.length > 2;
  const visible = collapsed ? path.slice(-2) : path;

  return (
    <nav className="crumbs" aria-label="書籤資料夾路徑">
      <button
        type="button"
        className="crumbs__item"
        onClick={() => {
          onNavigate(null);
        }}
      >
        全部
      </button>

      {collapsed ? <span className="crumbs__sep">/ …</span> : null}

      {visible.map((folder, position) => {
        const isLast = position === visible.length - 1;
        return (
          <span key={folder.id} className="crumbs__group">
            <span className="crumbs__sep">/</span>
            {isLast ? (
              <span className="crumbs__item crumbs__item--current" aria-current="page">
                {folder.title || '（未命名）'}
              </span>
            ) : (
              <button
                type="button"
                className="crumbs__item"
                onClick={() => {
                  onNavigate(folder.id);
                }}
              >
                {folder.title || '（未命名）'}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
