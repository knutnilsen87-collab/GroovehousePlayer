/**
 * Spillelistefarger (del 9 pkt. 15). Kopi av docs/design/playlist-colors.json – testen i
 * packages/shared/test/playlists.test.ts sjekker at de er like. Ingen gull: gull er rammen for hele appen.
 */
export interface PlaylistColor {
  id: string;
  name: string;
  group: 'neon' | 'candy';
  primary: string;
  secondary: string;
  onPrimary: string;
}

export const PLAYLIST_COLOR_GROUPS = {"neon":"Neon","candy":"Candy"} as const;

/** box-shadow-oppskriften fra JSON-fila; {primary} byttes ut. */
export const NEON_GLOW_CSS = "0 0 6px {primary}, 0 0 18px {primary}99, 0 0 36px {primary}55";

export const PLAYLIST_COLORS: PlaylistColor[] = [
  {
    "id": "neon-cyan",
    "name": "Neon Cyan",
    "group": "neon",
    "primary": "#2FE6FF",
    "secondary": "#0092A6",
    "onPrimary": "#07080B"
  },
  {
    "id": "sky",
    "name": "Himmelblå",
    "group": "neon",
    "primary": "#5EC8FF",
    "secondary": "#007EC0",
    "onPrimary": "#07080B"
  },
  {
    "id": "electric-blue",
    "name": "Elektrisk blå",
    "group": "neon",
    "primary": "#5B8CFF",
    "secondary": "#0039BE",
    "onPrimary": "#07080B"
  },
  {
    "id": "ultramarine",
    "name": "Ultramarin",
    "group": "neon",
    "primary": "#7A6BFF",
    "secondary": "#1400C7",
    "onPrimary": "#07080B"
  },
  {
    "id": "violet-haze",
    "name": "Fiolett dis",
    "group": "neon",
    "primary": "#A879FF",
    "secondary": "#4900CF",
    "onPrimary": "#07080B"
  },
  {
    "id": "ultraviolet",
    "name": "Ultrafiolett",
    "group": "neon",
    "primary": "#C45CFF",
    "secondary": "#7A00BF",
    "onPrimary": "#07080B"
  },
  {
    "id": "magenta-pulse",
    "name": "Magenta puls",
    "group": "neon",
    "primary": "#FF45D0",
    "secondary": "#B20085",
    "onPrimary": "#07080B"
  },
  {
    "id": "hot-pink",
    "name": "Hot pink",
    "group": "neon",
    "primary": "#FF5CA8",
    "secondary": "#BF0059",
    "onPrimary": "#07080B"
  },
  {
    "id": "cherry",
    "name": "Kirsebær",
    "group": "neon",
    "primary": "#FF3D6E",
    "secondary": "#AE002C",
    "onPrimary": "#07080B"
  },
  {
    "id": "sunset-red",
    "name": "Solnedgang",
    "group": "neon",
    "primary": "#FF5454",
    "secondary": "#BA0000",
    "onPrimary": "#07080B"
  },
  {
    "id": "coral",
    "name": "Korall",
    "group": "neon",
    "primary": "#FF7A66",
    "secondary": "#C41A00",
    "onPrimary": "#07080B"
  },
  {
    "id": "ember",
    "name": "Glo",
    "group": "neon",
    "primary": "#FF8136",
    "secondary": "#AA3F00",
    "onPrimary": "#07080B"
  },
  {
    "id": "acid-lime",
    "name": "Syre-lime",
    "group": "neon",
    "primary": "#C8FF3D",
    "secondary": "#7DAE00",
    "onPrimary": "#07080B"
  },
  {
    "id": "neon-green",
    "name": "Neongrønn",
    "group": "neon",
    "primary": "#3DFF8F",
    "secondary": "#00AE49",
    "onPrimary": "#07080B"
  },
  {
    "id": "mint",
    "name": "Mynte",
    "group": "neon",
    "primary": "#5CFFC9",
    "secondary": "#00BF80",
    "onPrimary": "#07080B"
  },
  {
    "id": "aqua",
    "name": "Akva",
    "group": "neon",
    "primary": "#22E8C8",
    "secondary": "#0E8571",
    "onPrimary": "#07080B"
  },
  {
    "id": "teal-glow",
    "name": "Turkis glød",
    "group": "neon",
    "primary": "#1FCFC0",
    "secondary": "#11726A",
    "onPrimary": "#07080B"
  },
  {
    "id": "ice",
    "name": "Is",
    "group": "neon",
    "primary": "#A9E8FF",
    "secondary": "#00ABE9",
    "onPrimary": "#07080B"
  },
  {
    "id": "lavender",
    "name": "Lavendel",
    "group": "neon",
    "primary": "#BCA9FF",
    "secondary": "#3400E9",
    "onPrimary": "#07080B"
  },
  {
    "id": "rose-quartz",
    "name": "Rosekvarts",
    "group": "neon",
    "primary": "#F7ABDA",
    "secondary": "#D21489",
    "onPrimary": "#07080B"
  },
  {
    "id": "peach",
    "name": "Fersken",
    "group": "neon",
    "primary": "#FFB591",
    "secondary": "#DC4800",
    "onPrimary": "#07080B"
  },
  {
    "id": "electric-orchid",
    "name": "Orkidé",
    "group": "neon",
    "primary": "#E07BFF",
    "secondary": "#9F00D0",
    "onPrimary": "#07080B"
  },
  {
    "id": "bubblegum",
    "name": "Tyggegummi",
    "group": "candy",
    "primary": "#FF7AD9",
    "secondary": "#CF0094",
    "onPrimary": "#07080B"
  },
  {
    "id": "blue-raspberry",
    "name": "Blå bringebær",
    "group": "candy",
    "primary": "#3DC2FF",
    "secondary": "#0077AE",
    "onPrimary": "#07080B"
  },
  {
    "id": "sour-apple",
    "name": "Sur eple",
    "group": "candy",
    "primary": "#8CFF4D",
    "secondary": "#41B700",
    "onPrimary": "#07080B"
  },
  {
    "id": "watermelon",
    "name": "Vannmelon",
    "group": "candy",
    "primary": "#FF5C7A",
    "secondary": "#BF0023",
    "onPrimary": "#07080B"
  },
  {
    "id": "plasma",
    "name": "Plasma",
    "group": "candy",
    "primary": "#9D4DFF",
    "secondary": "#5200B7",
    "onPrimary": "#07080B"
  },
  {
    "id": "toxic",
    "name": "Giftgrønn",
    "group": "candy",
    "primary": "#7CFF2E",
    "secondary": "#3EA600",
    "onPrimary": "#07080B"
  },
  {
    "id": "holo-blue",
    "name": "Holoblå",
    "group": "candy",
    "primary": "#4DE1FF",
    "secondary": "#0098B7",
    "onPrimary": "#07080B"
  },
  {
    "id": "candy-apple",
    "name": "Kandisert eple",
    "group": "candy",
    "primary": "#FF3B3B",
    "secondary": "#AD0000",
    "onPrimary": "#07080B"
  },
  {
    "id": "electric-lilac",
    "name": "Elektrisk syrin",
    "group": "candy",
    "primary": "#D69CFF",
    "secondary": "#8400E2",
    "onPrimary": "#07080B"
  },
  {
    "id": "peach-fizz",
    "name": "Fersken-brus",
    "group": "candy",
    "primary": "#FF9A7A",
    "secondary": "#CF3200",
    "onPrimary": "#07080B"
  },
  {
    "id": "ultra-pink",
    "name": "Ultrarosa",
    "group": "candy",
    "primary": "#FF66F5",
    "secondary": "#C400B8",
    "onPrimary": "#07080B"
  },
  {
    "id": "glacier-mint",
    "name": "Isbre-mynte",
    "group": "candy",
    "primary": "#7DFFF2",
    "secondary": "#00D1BC",
    "onPrimary": "#07080B"
  },
  {
    "id": "razzle",
    "name": "Razzle",
    "group": "candy",
    "primary": "#FF3D9A",
    "secondary": "#AE0053",
    "onPrimary": "#07080B"
  },
  {
    "id": "cotton-candy",
    "name": "Sukkerspinn",
    "group": "candy",
    "primary": "#FFB8F5",
    "secondary": "#F100CF",
    "onPrimary": "#07080B"
  },
  {
    "id": "lemon-drop",
    "name": "Sitrondrops",
    "group": "candy",
    "primary": "#FFEA3D",
    "secondary": "#AE9B00",
    "onPrimary": "#07080B"
  },
  {
    "id": "cyber-pink",
    "name": "Cyberrosa",
    "group": "candy",
    "primary": "#FF1FC4",
    "secondary": "#9D0074",
    "onPrimary": "#07080B"
  },
  {
    "id": "berry-blast",
    "name": "Bærbombe",
    "group": "candy",
    "primary": "#E03DFF",
    "secondary": "#9200AE",
    "onPrimary": "#07080B"
  },
  {
    "id": "sherbet-lime",
    "name": "Lime-sorbet",
    "group": "candy",
    "primary": "#DAFF7A",
    "secondary": "#96CF00",
    "onPrimary": "#07080B"
  }
];
