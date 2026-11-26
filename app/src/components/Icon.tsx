import React from 'react';
import {ChevronLeft, FileText, Flag, FlagOff, LucideIcon, MapIcon, Pin, PinOff, ScanLine, Settings, SlidersHorizontal, Upload} from 'lucide-react-native';

// Same icon set and wrapper API as super-badger's app (lucide-react-native,
// rendered through react-native-svg), so the two apps' chrome is drawn the
// same way. Add names here as screens need them.
export type IconName = 'gear' | 'chevron-left' | 'logs' | 'filter' | 'map' | 'pin' | 'pin-off' | 'flag' | 'flag-off' | 'upload' | 'scan-line';

const ICONS: Record<IconName, LucideIcon> = {
  gear: Settings,
  'chevron-left': ChevronLeft,
  logs: FileText,
  filter: SlidersHorizontal,
  map: MapIcon,
  pin: Pin,
  'pin-off': PinOff,
  flag: Flag,
  'flag-off': FlagOff,
  upload: Upload,
  'scan-line': ScanLine,
};

export function Icon({
  name,
  size = 20,
  color = '#000',
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} color={color} strokeWidth={strokeWidth} />;
}
