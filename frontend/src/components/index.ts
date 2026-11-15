// Primitivas del sistema de diseno (DESIGN.md). Son componentes de
// presentacion: sin estado global ni llamadas a la API. Todo texto llega por
// props ya traducido, salvo los nombres accesibles propios de cada pieza, que
// salen del namespace "components" de i18n.
//
// La galeria con todos los estados esta en /?dev=gallery (gallery.devpage.tsx).

export {
  Button,
  ButtonLink,
  type ButtonLinkProps,
  type ButtonProps,
  type ButtonVariant,
} from "./Button";
export { ControlHeader, type ControlHeaderProps } from "./ControlHeader";
export { classNames } from "./classNames";
export { DataGroup, type DataGroupProps, DataRow, type DataRowProps } from "./DataRow";
export {
  type DisabledReasonProps,
  type DisabledReasonState,
  useDisabledReason,
  withoutHandlers,
} from "./DisabledReason";
export { GlassPanel, type GlassPanelProps } from "./GlassPanel";
export { ICON_NAMES, Icon, type IconName, type IconProps } from "./Icon";
export {
  IconButton,
  type IconButtonProps,
  type IconButtonShape,
  type IconButtonSize,
  type IconButtonVariant,
  IconLink,
  type IconLinkProps,
} from "./IconButton";
export { ImageTag, type ImageTagProps } from "./ImageTag";
export { LanguageSelector, type LanguageSelectorProps } from "./LanguageSelector";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar";
export {
  groupNotices,
  type NoticeGroup,
  type NoticeItem,
  QualityNotice,
  QualityNoticeList,
  type QualityNoticeListProps,
  type QualityNoticeProps,
} from "./QualityNotice";
export {
  QuickLink,
  QuickLinkList,
  type QuickLinkListProps,
  type QuickLinkProps,
} from "./QuickLink";
export { SearchField, type SearchFieldProps } from "./SearchField";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./SegmentedControl";
export { Slider, type SliderProps } from "./Slider";
export {
  EPOCH_LEGEND_STATES,
  EPOCH_MARKER_STATES,
  EpochLegend,
  type EpochLegendProps,
  EpochMarker,
  type EpochMarkerProps,
  type EpochMarkerState,
  type EpochStatus,
  type TimelineEpoch,
  TimelineTrack,
  type TimelineTrackProps,
} from "./Timeline";
export { Toggle, type ToggleProps } from "./Toggle";
export { Transport, type TransportProps } from "./Transport";
export {
  EPOCH_STOP_WIDTH_PX,
  layoutEpochs,
  MIN_EPOCH_GAP,
  minEpochGap,
} from "./timelineLayout";
