import { useColorScheme } from 'react-native';

const light = {
  bg: '#F6F7F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF1EC',
  text: '#17201B',
  textDim: '#5F6B64',
  border: '#DFE4DD',
  primary: '#2F9E6E',
  primarySoft: '#DDF3E8',
  onPrimary: '#FFFFFF',
  danger: '#D64545',
  dangerSoft: '#FBE4E4',
  warn: '#C98A12',
  warnSoft: '#FBF0D6',
  info: '#3B82F6',
  infoSoft: '#E1ECFE',
};

const dark: typeof light = {
  bg: '#101412',
  surface: '#1A201D',
  surfaceAlt: '#232B27',
  text: '#ECF1ED',
  textDim: '#9BA8A0',
  border: '#2E3833',
  primary: '#4CC38A',
  primarySoft: '#1D3A2D',
  onPrimary: '#08130D',
  danger: '#F27474',
  dangerSoft: '#3D2020',
  warn: '#E5B04A',
  warnSoft: '#3A2F17',
  info: '#6EA8FE',
  infoSoft: '#1B2B45',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 24, pill: 999 } as const;
