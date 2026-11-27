// react-native for tests: its Flow sources don't load under node, and only these
// few names are touched by the modules under test.
export const Platform = { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default }
export const useColorScheme = () => 'light'
