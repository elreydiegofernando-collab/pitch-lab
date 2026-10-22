/**
 * Snapshot of the verified bundled charts (public/songs), used by bundled.test.ts to catch accidental
 * edits. Each `notes` string lists every note as `<startBeat>.<lengthBeats>.<pitch>` (a trailing "~"
 * marks a continuation note that carries no syllable), `lines` the lyric text of each phrase.
 *
 * Provenance of the melodies (all checked bar by bar against public-domain notation):
 *  - amazing-grace: E. O. Excell's 1900 setting of NEW BRITAIN (HymnWiki LilyPond), transposed G -> D.
 *  - danny-boy: Londonderry Air in E-flat (Wikipedia LilyPond score), transposed to G; Weatherly 1913 words.
 *  - auld-lang-syne: Wikipedia LilyPond score with slur-aligned words, transposed F -> C.
 *  - silent-night: Gruber, contemporary version (Wikipedia LilyPond score, agreeing with the Mutopia
 *    cyberhymnal setting), transposed C -> F.
 *  - ave-maria: Schubert D. 839, Latin adaptation sequenced by Rabanus Flavus (CC0, Wikimedia Commons;
 *    pitches/onsets/values from the MIDI, syllables from the score image), one octave down.
 *  - twinkle-twinkle: the folk tune, in F.
 * Regenerate only after re-verifying a melody against its source.
 */
export interface BundledExpectation {
  id: string;
  title: string;
  notes: string;
  lines: string[];
}

export const BUNDLED_EXPECTED: BundledExpectation[] = [
  {
    id: 'twinkle-twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    notes:
      '0.4.F3 4.4.F3 8.4.C4 12.4.C4 16.4.D4 20.4.D4 24.8.C4 32.4.A#3 36.4.A#3 40.4.A3 44.4.A3 48.4.G3 52.4.G3 ' +
      '56.8.F3 64.4.C4 68.4.C4 72.4.A#3 76.4.A#3 80.4.A3 84.4.A3 88.8.G3 96.4.C4 100.4.C4 104.4.A#3 108.4.A#3 ' +
      '112.4.A3 116.4.A3 120.8.G3 128.4.F3 132.4.F3 136.4.C4 140.4.C4 144.4.D4 148.4.D4 152.8.C4 160.4.A#3 ' +
      '164.4.A#3 168.4.A3 172.4.A3 176.4.G3 180.4.G3 184.8.F3',
    lines: [
      'Twinkle, twinkle, little star,',
      'How I wonder what you are!',
      'Up above the world so high,',
      'Like a diamond in the sky.',
      'Twinkle, twinkle, little star,',
      'How I wonder what you are!',
    ],
  },
  {
    id: 'auld-lang-syne',
    title: 'Auld Lang Syne',
    notes:
      '0.4.G3 4.6.C4 10.2.C4 12.4.C4 16.4.E4 20.6.D4 26.2.C4 28.4.D4 32.4.E4 36.6.C4 42.2.C4 44.4.E4 48.4.G4 ' +
      '52.12.A4 64.4.A4 68.6.G4 74.2.E4 76.4.E4 80.4.C4 84.6.D4 90.2.C4 92.4.D4 96.4.E4 100.6.C4 106.2.A3~ 108.4.A3 ' +
      '112.4.G3~ 116.12.C4 128.4.A4 132.6.G4 138.2.E4~ 140.4.E4 144.4.C4~ 148.6.D4 154.2.C4 156.4.D4 160.4.A4 ' +
      '164.6.G4 170.2.E4~ 172.4.E4 176.4.G4~ 180.12.A4 192.4.A4 196.6.G4 202.2.E4 204.4.E4 208.4.C4 212.6.D4 ' +
      '218.2.C4 220.4.D4 224.4.E4 228.6.C4 234.2.A3~ 236.4.A3 240.4.G3~ 244.12.C4',
    lines: [
      'Should auld acquaintance be forgot,',
      'and never brought to mind?',
      'Should auld acquaintance be forgot,',
      'and auld lang syne?',
      'For auld lang syne, my jo,',
      'for auld lang syne,',
      'we\'ll tak\' a cup o\' kindness yet,',
      'for auld lang syne.',
    ],
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    notes:
      '0.4.A3 4.8.D4 12.2.F#4 14.2.D4~ 16.8.F#4 24.4.E4 28.8.D4 36.4.B3 40.8.A3 48.4.A3 52.8.D4 60.2.F#4 62.2.D4~ ' +
      '64.8.F#4 72.4.E4 76.12.A4 88.4.F#4 92.6.A4 98.2.F#4~ 100.2.A4 102.2.F#4~ 104.8.D4 112.4.A3 116.6.B3 ' +
      '122.2.D4~ 124.2.D4 126.2.B3~ 128.8.A3 136.4.A3 140.8.D4 148.2.F#4 150.2.D4~ 152.8.F#4 160.4.E4 164.8.D4',
    lines: [
      'Amazing grace! How sweet the sound',
      'That saved a wretch like me!',
      'I once was lost, but now am found;',
      'Was blind, but now I see.',
    ],
  },
  {
    id: 'silent-night',
    title: 'Silent Night',
    notes:
      '0.3.C4 3.1.D4 4.2.C4 6.6.A3~ 12.3.C4 15.1.D4 16.2.C4 18.6.A3~ 24.4.G4 28.2.G4 30.6.E4 36.4.F4 40.2.F4 ' +
      '42.6.C4 48.4.D4 52.2.D4 54.3.F4 57.1.E4 58.2.D4 60.3.C4 63.1.D4 64.2.C4 66.6.A3~ 72.4.D4 76.2.D4 78.3.F4 ' +
      '81.1.E4 82.2.D4 84.3.C4 87.1.D4 88.2.C4 90.6.A3 96.4.G4 100.2.G4 102.3.A#4 105.1.G4 106.2.E4 108.6.F4 ' +
      '114.4.A4~ 120.3.F4 123.1.C4~ 124.2.A3 126.3.C4 129.1.A#3 130.2.G3 132.10.F3',
    lines: [
      'Silent night, holy night,',
      'All is calm, all is bright,',
      'Round yon virgin mother and child,',
      'Holy infant so tender and mild,',
      'Sleep in heavenly peace,',
      'Sleep in heavenly peace.',
    ],
  },
  {
    id: 'danny-boy',
    title: 'Danny Boy',
    notes:
      '0.2.F#3 2.2.G3 4.2.A3 6.6.B3 12.2.A3 14.2.B3 16.2.E4 18.2.D4 20.2.B3 22.2.A3 24.2.G3 26.4.E3~ 32.2.G3 ' +
      '34.2.B3 36.2.C4 38.6.D4 44.2.E4 46.2.D4 48.2.B3 50.2.G3 52.2.B3 54.8.A3 64.2.F#3 66.2.G3 68.2.A3 70.6.B3 ' +
      '76.2.A3 78.2.B3 80.2.E4 82.2.D4 84.2.B3 86.2.A3 88.2.G3 90.2.E3~ 92.2.D#3~ 94.2.E3~ 96.2.F#3 98.2.G3 ' +
      '100.2.A3 102.6.B3 108.2.C4 110.2.B3 112.2.A3 114.2.G3 116.2.A3 118.8.G3 128.2.D4 130.2.E4 132.2.F#4 134.6.G4 ' +
      '140.2.F#4 142.2.F#4 144.2.E4 146.2.D4 148.2.B3 150.2.D4 152.2.B3 154.4.G3~ 160.2.D4 162.2.E4 164.2.F#4 ' +
      '166.6.G4 172.2.F#4 174.2.F#4 176.2.E4 178.2.D4 180.2.B3 182.8.A3 192.2.D4 194.2.D4 196.2.D4 198.6.B4 ' +
      '204.2.A4 206.2.A4 208.2.G4 210.2.E4 212.2.G4 214.2.D4 216.2.B3 218.4.G3~ 224.2.F#3 226.2.G3 228.2.A3 ' +
      '230.2.B3 232.2.E4 234.2.D4 236.2.B3 238.2.A3 240.2.G3 242.2.E3 244.2.F#3 246.10.G3',
    lines: [
      'Oh Danny boy, the pipes, the pipes are calling,',
      'From glen to glen, and down the mountain side.',
      'The summer\'s gone, and all the roses falling,',
      '\'Tis you, \'tis you must go and I must bide.',
      'But come ye back when summer\'s in the meadow,',
      'Or when the valley\'s hushed and white with snow,',
      '\'Tis I\'ll be here in sunshine or in shadow,',
      'Oh Danny boy, oh Danny boy, I love you so.',
    ],
  },
  {
    id: 'ave-maria',
    title: 'Ave Maria',
    notes:
      '0.72.A#3 72.12.A3 84.12.A#3 96.84.D4 180.12.C4~ 192.48.A#3 288.36.C4 324.6.D4 330.6.C4 336.12.A#3 348.12.A3~ ' +
      '360.12.G3~ 372.12.A3~ 384.48.A#3 456.24.D4 480.36.D4 516.6.C4 522.6.A#3~ 528.12.A3 540.12.G3~ 552.12.D4 ' +
      '564.12.E4 576.48.D4 624.36.C#4 660.12.A3 672.36.C4 708.12.A#3 720.8.A3 728.8.C4~ 736.8.D4 744.8.D#4 ' +
      '752.8.C4~ 760.8.A3 768.72.A#3 840.12.D4 852.12.C4~ 864.36.C4 900.12.A3 912.8.G3 920.8.B3 928.8.D4 936.8.F4 ' +
      '944.8.D4 952.8.B3 960.16.C4 976.8.C4 984.16.C4 1000.8.C4 1008.8.C4 1016.8.G3 1024.4.A3 1028.4.A3 1032.4.A#3 ' +
      '1036.3.C4~ 1039.3.A#3~ 1042.6.A3~ 1048.8.G3~ 1056.48.F3 1128.8.F3 1136.8.F3 1144.8.F3 1152.36.C4 1188.12.C4 ' +
      '1200.18.C4 1218.6.B3~ 1224.18.C4 1242.6.D4~ 1248.18.C4 1266.6.D4~ 1272.24.A#3 1320.24.A#3 1344.16.C4 ' +
      '1360.8.C4 1368.16.C4 1384.8.C4 1392.8.C4 1400.8.B3~ 1408.8.C4 1416.8.D#4 1424.8.D4~ 1432.8.C4 1440.48.A#3 ' +
      '1512.24.A#3 1536.36.C4 1572.12.C4 1584.18.D4 1602.6.D4 1608.8.D4 1616.8.C4~ 1624.8.D4 1632.12.F4 ' +
      '1644.12.D#4~ 1656.24.D#4 1704.8.G3 1712.8.G3 1720.8.G3 1728.12.D4 1740.12.C4~ 1752.24.C4 1776.8.A#3 ' +
      '1784.8.A3~ 1792.8.A#3 1800.8.C#4 1808.8.C4~ 1816.8.A#3~ 1824.72.C4 1920.72.A#3 1992.12.A3 2004.12.A#3 ' +
      '2016.84.D4 2100.12.C4~ 2112.48.A#3',
    lines: [
      'Ave Maria,',
      'gratia plena,',
      'Maria, Dominus tecum,',
      'Maria, benedicta tu in mulieribus,',
      'et benedictus fructus ventris tui Jesus.',
      'Sancta Maria,',
      'mater Dei,',
      'ora pro nobis peccatoribus',
      'nunc et in hora mortis nostrae,',
      'in hora mortis nostrae.',
      'Amen.',
      'Ave Maria.',
    ],
  },
];
