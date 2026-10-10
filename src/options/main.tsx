import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/tokens.css';
import '../ui/components.css';
import './options.css';
import { Options } from './Options';
import { t } from '@/shared/i18n';
import { applyDocumentLocale } from '@/shared/document-locale';

applyDocumentLocale(t('page_title_options'));

const container = document.getElementById('root');
if (container === null) {
  throw new Error(t('root_container_missing'));
}

createRoot(container).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
