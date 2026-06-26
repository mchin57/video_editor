# Bundled fonts — licenses

All fonts shipped in this folder are free/open-source and redistributable inside
the installer. They are passed to libass via `fontsdir` on export and served to
the renderer (`reelmedia://fonts/<file>`) for `@font-face` previews.

The catalog (id → file → libass family name) lives in `src/shared/fonts.ts`.

| Font | File | License |
|---|---|---|
| Montserrat ExtraBold | `Montserrat-ExtraBold.ttf` | SIL Open Font License 1.1 |
| Montserrat Black | `Montserrat-Black.ttf` | SIL Open Font License 1.1 |
| Poppins ExtraBold | `Poppins-ExtraBold.ttf` | SIL Open Font License 1.1 |
| Poppins Black | `Poppins-Black.ttf` | SIL Open Font License 1.1 |
| Barlow Semi Condensed ExtraBold | `BarlowSemiCondensed-ExtraBold.ttf` | SIL Open Font License 1.1 |
| Anton | `Anton-Regular.ttf` | SIL Open Font License 1.1 |
| Bebas Neue | `BebasNeue-Regular.ttf` | SIL Open Font License 1.1 |
| Archivo Black | `ArchivoBlack-Regular.ttf` | SIL Open Font License 1.1 |
| Barlow Condensed Black | `BarlowCondensed-Black.ttf` | SIL Open Font License 1.1 |
| Permanent Marker | `PermanentMarker-Regular.ttf` | Apache License 2.0 |
| Bangers | `Bangers-Regular.ttf` | SIL Open Font License 1.1 |
| Pacifico | `Pacifico-Regular.ttf` | SIL Open Font License 1.1 |
| Shrikhand | `Shrikhand-Regular.ttf` | SIL Open Font License 1.1 |
| Abril Fatface | `AbrilFatface-Regular.ttf` | SIL Open Font License 1.1 |

SIL OFL 1.1: https://scripts.sil.org/OFL — Apache 2.0: https://www.apache.org/licenses/LICENSE-2.0

The full OFL/Apache license texts ship with each font's upstream package
(Google Fonts) and are reproduced there; redistribution here is permitted under
both licenses provided this notice is retained.
