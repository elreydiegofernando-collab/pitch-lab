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
 *  - the-holy-city: Adams's melody as printed in the 1892 Boosey & Co. edition in D-flat (Internet Archive
 *    sm_theholycity = Connecticut College Historic Sheet Music 590), checked against the Boosey & Hawkes A-flat
 *    reprint (Internet Archive CSM_00012) and note for note against the CPDL #04414 MusicXML (A-flat); verse 1
 *    and refrain with the 1892 Weatherly words as printed; sung an octave below the written treble clef.
 *  - holy-holy-holy: Dykes's NICAEA (Hymns Ancient and Modern, 1861), the soprano line of the Open Hymnal ABC (music
 *    source: Hymns Ancient and Modern, 1869, hymn 135), checked note for note against the Cyber Hymnal MIDI of the
 *    1861 setting; transposed D -> C.
 *  - it-is-well: Bliss's VILLE DU HAVRE (Gospel Hymns No. 2, 1876), the soprano line of the Open Hymnal ABC (music
 *    source: The Evangelical Hymnal, 1921, hymn 208), checked note for note against the Cyber Hymnal MIDI of the
 *    1876 setting and against the Mutopia LilyPond made from it (which writes two "with my" pairs as straight
 *    quarters; the chart keeps the dotted rhythm of the 1876 print); the fermata on the fourth line's final "soul."
 *    held one beat longer, as in the Cyber Hymnal MIDI; transposed D-flat -> B-flat.
 *  - o-holy-night: Adam's melody as printed in the Leon Grus edition (Mutopia LilyPond, ed. Gerard Greco) and the
 *    1871 G. Schirmer "Social Evenings" scan, cross-checked against the 1912 High School Assembly Song Book
 *    (HymnWiki LilyPond); the third note ("ly") is Adam's own rising third, not the E E E G of later English
 *    hymnals; English words by J. S. Dwight (1855) underlaid as in the 1871 and 1912 editions; transposed C -> F.
 *  - panis-angelicus: Franck's tenor/soprano line (A major, Messe a trois voix Op. 12), both statements, read bar
 *    by bar from the vocal part of the O. Bornemann print (BnF Gallica btv1b108722495, 1889) and from the 1908
 *    Boston Music Co. / G. Schirmer edition ed. A. H. Ryder (Internet Archive olordmostholyp00fran1908), checked
 *    against the Bornemann G-major edition (Internet Archive panisangelicuspo112fran) and note for note against the
 *    CPDL #26337 MusicXML (G major); Latin underlay as printed; sung an octave below the written treble clef.
 *  - be-thou-my-vision: SLANE (traditional Irish, first printed as "With My Love on the Road" in Joyce, Old Irish
 *    Folk Music and Songs, 1909) as the Open Hymnal ABC sets it (Mark Hamilton Dewey's 2007 setting, released to the
 *    public domain), checked note for note against the HymnWiki/CPDL Dewey LilyPond and against the 1909 folk
 *    original (HymnWiki LilyPond, less its three lead-in notes); the first verse of Eleanor Hull's 1912 words;
 *    transposed E-flat -> C.
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
  {
    id: 'the-holy-city',
    title: 'The Holy City',
    notes:
      '0.6.G#3 6.9.C#4 15.3.C#4 18.6.C#4 24.6.C#4 30.6.C4 36.6.C4 48.6.C4 54.6.A#3 60.6.A#3 66.9.C4 75.3.A#3 ' +
      '78.12.G#3 96.6.G#3 102.6.G#3 108.6.G#3 114.9.C#4 123.3.C4 126.9.C4 135.3.A#3 138.6.A#3 144.6.A#3 150.9.A#3 ' +
      '159.3.A#3 162.6.C4 168.6.C#4 174.12.C4 192.6.G#3 198.9.C#4 207.3.C#4 210.6.C#4 216.6.C#4 222.6.C4 228.6.C4 ' +
      '240.6.C4 246.6.A#3 252.6.A#3 258.9.C4 267.3.A#3 270.12.G#3 288.6.G#3 294.9.G#3 303.3.G#3 306.6.G3 312.6.G#3 ' +
      '318.12.C4 330.6.A#3 336.6.G#3 342.9.C#4 351.3.C#4 354.6.C4 360.6.A#3 366.12.D#4 384.6.D#4 390.12.D#4 ' +
      '402.12.D#4 414.18.G4 432.6.F4 438.12.D#4 450.12.C4~ 462.6.G#3 474.12.C#4 486.18.C4 504.6.C4 510.12.C4 ' +
      '522.12.A#3 534.24.G#3 570.12.G#3 582.18.C#4 600.6.G#3 606.12.G#3 618.12.G#3 630.18.F4 648.6.D#4 654.12.C#4 ' +
      '678.12.C#4 690.8.C#4 698.4.C4 702.12.C#4 714.12.F#4 726.24.F4 762.12.F4 774.24.D#4 798.12.G#3 810.4.G#3 ' +
      '814.4.C4~ 818.4.D#4 822.24.G#4 846.6.C#4 858.12.F#4 870.12.F4 882.4.F4 886.4.D#4~ 890.4.C#4~ 894.12.D#4 ' +
      '906.12.F4 918.24.C#4',
    lines: [
      'Last night I lay a sleeping,',
      'There came a dream so fair,',
      'I stood in old Jerusalem',
      'Beside the temple there.',
      'I heard the children singing,',
      'And ever as they sang,',
      'Methought the voice of Angels',
      'From Heav\'n in answer rang;',
      'Methought the voice of Angels',
      'From Heav\'n in answer rang.',
      'Jerusalem! Jerusalem!',
      'Lift up your gates and sing,',
      'Hosanna in the highest!',
      'Hosanna to your King!',
    ],
  },
  {
    id: 'holy-holy-holy',
    title: 'Holy, Holy, Holy! Lord God Almighty',
    notes:
      '0.4.C4 4.4.C4 8.4.E4 12.4.E4 16.8.G4 24.8.G4 32.8.A4 40.4.A4 44.4.A4 48.8.G4 56.8.E4 64.6.G4 70.2.G4 ' +
      '72.4.G4 76.4.G4 80.8.C5 88.4.B4 92.4.G4 96.4.D4 100.4.G4 104.6.A4 110.2.G4 112.16.G4 128.4.C4 132.4.C4 ' +
      '136.4.E4 140.4.E4 144.8.G4 152.8.G4 160.6.A4 166.2.A4 168.4.A4 172.4.A4 176.8.G4 184.8.G4 192.8.C5 200.4.G4 ' +
      '204.4.G4 208.8.A4 216.8.E4 224.4.F4 228.4.D4 232.6.D4 238.2.C4 240.16.C4',
    lines: [
      'Holy, holy, holy! Lord God Almighty!',
      'Early in the morning our song shall rise to Thee;',
      'Holy, holy, holy! Merciful and mighty!',
      'God in three Persons, blessed Trinity!',
    ],
  },
  {
    id: 'it-is-well',
    title: 'It Is Well with My Soul',
    notes:
      '0.4.F4 4.8.F4 12.4.D#4 16.4.D4 20.8.D4 28.4.C4 32.4.D4 36.4.D#4 40.4.G4~ 44.4.F4 48.4.D#4 52.12.D4 64.4.F4 ' +
      '68.8.A#4 76.4.A4 80.4.G4 84.8.G4 92.4.F4 96.4.E4 100.12.F4 112.4.F4 116.8.A#4 124.4.A#4 128.4.A4 132.8.G4 ' +
      '140.4.G4 144.4.G4 148.8.C5 156.4.C5 160.4.A#4 164.8.A4 172.4.G4 176.4.F4 180.8.A#4 188.4.A#4 192.4.A#4 ' +
      '196.8.A#4 204.6.A4 210.2.A#4 212.12.A#4 224.4.F4 228.4.F4 232.24.F4 256.4.F4 260.4.F4 264.24.F4 288.4.D4 ' +
      '292.4.F4 296.8.G4 304.4.G4 308.4.A#4 312.8.A#4 320.6.A4 326.2.A#4 328.12.A#4',
    lines: [
      'When peace, like a river, attendeth my way,',
      'When sorrows like sea billows roll;',
      'Whatever my lot, Thou hast taught me to say,',
      'It is well, it is well with my soul.',
      'It is well,',
      'with my soul,',
      'It is well, it is well with my soul.',
    ],
  },
  {
    id: 'o-holy-night',
    title: 'O Holy Night',
    notes:
      '0.1.A3 1.7.A3 8.1.C4 9.7.C4 16.1.C4 17.3.D4 20.1.D4 21.3.A#3 24.1.D4 25.8.F4 33.2.C4 36.1.C4 37.3.A3 40.1.G3 ' +
      '41.4.F3 45.3.A3 48.1.A#3 49.4.C4 53.3.A#3 56.1.G3 57.8.F3 81.4.A3 85.3.A3 88.1.A3 89.7.C4 96.1.C4 97.3.D4 ' +
      '100.1.D4 101.3.A#3 104.1.D4 105.8.F4 113.2.C4 116.1.C4 117.3.B3 120.1.A3 121.4.E4 125.3.C4 128.1.D4 129.4.E4 ' +
      '133.3.F4 136.1.E4 137.8.A3 152.1.C4 153.4.C4 157.4.D4 161.4.G3 165.4.C4 169.3.D4 172.1.C4 173.3.F4 176.1.A3 ' +
      '177.4.D4 181.2.C4 184.1.C4 185.4.C4 189.4.D4 193.4.G3 197.4.C4 201.3.D4 204.1.C4 205.3.F4 208.1.A3 209.6.C4 ' +
      '217.12.F4 229.3.E4 232.1.D4 233.14.E4 248.1.E4 249.11.G4 260.1.D4 261.3.D4 264.1.D4 265.8.F4 273.4.F4 ' +
      '280.1.F4 281.8.A4 289.7.G4~ 296.1.C4 297.12.F4 309.3.E4 312.1.D4~ 313.11.C4 324.1.C4 325.3.D4 328.1.C4 ' +
      '329.12.C4 344.1.F4 345.15.G4 360.1.C4 361.12.A4 373.4.G4 377.8.F4 385.4.E4 389.3.F4 392.1.G4 393.8.F4',
    lines: [
      'O holy night! The stars are brightly shining,',
      'It is the night of the dear Saviour\'s birth.',
      'Long lay the world in sin and error pining,',
      'Till He appeared and the soul felt its worth.',
      'A thrill of hope the weary world rejoices,',
      'For yonder breaks a new and glorious morn;',
      'Fall on your knees! O hear the angel voices!',
      'O night divine, O night when Christ was born;',
      'O night divine, O night, O night divine!',
    ],
  },
  {
    id: 'panis-angelicus',
    title: 'Panis Angelicus',
    notes:
      '0.8.C#4 8.4.C#4 12.4.B3 16.3.B3 19.1.A3 20.4.A3 32.8.C#4 40.4.C#4 44.4.B3 48.3.B3 51.1.A3 52.4.A3 64.8.F#4 ' +
      '72.4.F#4 76.4.E4 80.6.D4 86.2.D4 88.4.D4 92.4.C#4 96.6.B3 102.2.B3 104.4.B3 108.4.A3 112.16.E4 128.8.C#4 ' +
      '136.4.C#4 140.4.B3 144.3.B3 147.1.A3 148.4.A3 160.8.E4 168.4.E4 172.4.D#4 176.3.D#4 179.1.C#4 180.4.C#4 ' +
      '192.8.C#4 200.4.B3 208.8.E4 216.4.B3 224.4.F#4 228.2.A3 230.2.B3 232.6.C#4 238.2.A3 240.8.G#3 256.8.C#4 ' +
      '264.4.G#3 272.6.D4 278.2.B3~ 280.4.A3 288.4.D#4 292.2.E4 294.2.F#4 296.6.C#4 302.2.D#4 304.8.E4 384.8.C#4 ' +
      '392.4.C#4 396.4.B3 400.3.B3 403.1.A3 404.4.A3 416.8.C#4 424.4.C#4 428.4.B3 432.3.B3 435.1.A3 436.4.A3 ' +
      '448.8.F#4 456.4.F#4 460.4.E4 464.6.D4 470.2.D4 472.4.D4 476.4.C#4 480.6.B3 486.2.B3 488.4.B3 492.4.A3 ' +
      '496.8.E4 512.8.E4 520.4.D4 524.4.C#4 528.3.C#4 531.1.B3 532.4.B3 544.8.E4 552.4.F#4 556.4.D4 560.3.C#4 ' +
      '563.1.B3 564.4.B3 576.10.E4 586.2.C#4~ 588.2.B3 590.2.A3~ 592.6.D4 598.2.B3~ 600.4.C#4 604.8.C#4 612.2.B3 ' +
      '614.2.A3 616.6.B3 622.2.C#4 624.8.A3 640.10.F#4 650.2.D4~ 652.2.C#4 654.2.B3~ 656.6.E4 662.2.C#4~ 664.4.D4 ' +
      '668.8.D4 676.2.B3 678.2.D4~ 680.4.C#4 684.2.B3 686.2.A3 688.14.B3 702.2.A3 704.8.A3',
    lines: [
      'Panis angelicus',
      'fit panis hominum,',
      'dat panis coelicus figuris terminum:',
      'O res mirabilis,',
      'manducat Dominum',
      'pauper, pauper,',
      'servus et humilis,',
      'pauper, pauper,',
      'servus et humilis.',
      'Panis angelicus',
      'fit panis hominum,',
      'dat panis coelicus figuris terminum:',
      'O res mirabilis,',
      'manducat Dominum',
      'pauper, pauper,',
      'servus et humilis,',
      'pauper, pauper,',
      'servus, servus et humilis.',
    ],
  },
  {
    id: 'be-thou-my-vision',
    title: 'Be Thou My Vision',
    notes:
      '0.4.C4 4.4.C4 8.2.D4 10.2.C4~ 12.4.A3 16.4.G3 20.2.G3 22.2.A3~ 24.4.C4 28.4.C4 32.4.D4 36.12.E4 48.4.D4 ' +
      '52.4.D4 56.4.D4 60.4.D4 64.4.E4 68.4.G4 72.4.A4 76.4.G4 80.4.E4 84.12.G4 96.4.A4 100.2.A4 102.2.B4~ ' +
      '104.2.C5~ 106.2.B4~ 108.4.A4 112.4.G4 116.4.E4 120.4.G4 124.4.C4 128.4.B3 132.8.A3 140.4.G3~ 144.4.C4 ' +
      '148.4.E4 152.4.G4 156.2.A4 158.2.G4~ 160.4.E4 164.2.C4 166.2.E4~ 168.4.D4 172.4.C4 176.4.C4 180.12.C4',
    lines: [
      'Be Thou my Vision, O Lord of my heart;',
      'Naught be all else to me, save that Thou art.',
      'Thou my best thought, by day or by night,',
      'Waking or sleeping, Thy presence my light.',
    ],
  },
];
