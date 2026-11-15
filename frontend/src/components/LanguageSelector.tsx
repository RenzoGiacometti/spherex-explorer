import { useTranslation } from "react-i18next";
import { type Language, SUPPORTED_LANGUAGES } from "@/i18n/languages";
import { SegmentedControl } from "./SegmentedControl";

export interface LanguageSelectorProps {
  /** Idioma activo. */
  readonly value: Language;
  /** Recibe el idioma elegido; cambiarlo de verdad (URL, i18next) queda para quien lo usa. */
  readonly onChange: (language: Language) => void;
  readonly className?: string | undefined;
}

/**
 * Selector de idioma (es, en) para la barra superior. Las celdas muestran el
 * codigo y el lector de pantalla anuncia el nombre completo del idioma.
 */
export function LanguageSelector({ value, onChange, className }: LanguageSelectorProps) {
  const { t } = useTranslation("common");
  return (
    <SegmentedControl
      label={t("language.label")}
      options={SUPPORTED_LANGUAGES.map((language) => ({
        value: language,
        label: language,
        ariaLabel: t(`language.${language}`),
      }))}
      value={value}
      onChange={onChange}
      fit="content"
      className={className}
    />
  );
}
