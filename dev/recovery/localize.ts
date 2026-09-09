import translations from '../../client/src/locales/en/translation.json';
export const useLocalize = () => (key: keyof typeof translations) => translations[key] || key;
