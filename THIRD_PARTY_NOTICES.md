# Third-party notices

`src/server/canvas/reconcile.ts` adapts the reconciliation and fractional-index
repair algorithms from [Excalidraw v0.18.1](https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw).

MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## MCP Excalidraw Server

The headless build/DOM bridge and agent drawing surface adapt ideas and portions
of [MCP Excalidraw Server](https://github.com/yctimlin/mcp_excalidraw).

MIT License

Copyright (c) 2024 MCP Excalidraw Server

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Fonts

Editor assets and headless fonts are copied, unmodified, from the pinned
`@excalidraw/excalidraw` package. Original font metadata is retained. SVG exports
embed these original WOFF2 binaries. Subset coverage is read from the binaries
at build time. The headless bundle also uses Excalidraw's native bounds and
binding helpers under the Excalidraw MIT notice above. Fonts have their own licenses:

| Font | Copyright / license |
| --- | --- |
| Virgil | Copyright (c) 2011 by Your Own Font Foundry. All rights reserved. SIL OFL 1.1. |
| Excalifont | Copyright (c) 2024 by Excalidraw. All rights reserved. SIL OFL 1.1, as recorded in Excalidraw's original-font metadata in `fonts/Excalifont/index.ts`. Excalifont is a trademark of Excalidraw. |
| Cascadia Code | © 2020 Microsoft Corporation. All Rights Reserved. SIL OFL 1.1; see https://github.com/microsoft/cascadia-code/blob/main/LICENSE. |
| Nunito | Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito). SIL OFL 1.1. |
| Lilita One | Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One". SIL OFL 1.1. |
| Comic Shanns Mono | Copyright (c) 2018 Shannon Miwa; 2023 Jesus Gonzalez; 2023 Rodrigo Batista de Moraes; 2024 Fini Jastrow; 2024 Kyle Beechly. MIT (permission and disclaimer reproduced above). |
| Xiaolai SC | Copyright © 2020 LXGW. Designer: Nozomi Seto / 瀬戸のぞみ. SIL OFL 1.1, as recorded in Excalidraw's original-font metadata in `fonts/Xiaolai/index.ts`. The bundled upstream subsets include Excalidraw's documented CJK-only, side-bearing and centering adjustments; Excalibur copies them unchanged. |
| Assistant | Copyright 2020 The Assistant Project Authors (https://github.com/hafontia/Assistant). Copyright 2010 The Source Sans Pro Authors (https://github.com/adobe-fonts/source-sans-pro), with Reserved Font Name 'Source'. Source is a trademark of Adobe Systems Incorporated in the United States and/or other countries. SIL OFL 1.1. |
| Liberation Sans | Digitized data © 2007 Ascender Corporation. All rights reserved. Copyright © 2007 Red Hat, Inc. GPL v2 with the Liberation font exceptions, **not** the modern Liberation 2.x OFL license. See below. |

Assistant and Xiaolai are included in both editor assets and headless bundles.
The Xiaolai license is also preserved in the original-font metadata at
https://github.com/excalidraw/excalidraw/blob/v0.18.0/packages/excalidraw/fonts/Xiaolai/index.ts.

### SIL Open Font License, Version 1.1 — 26 February 2007

PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS

"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting — in part or in whole — any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION

This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

### Liberation Sans (legacy version)

The original-font metadata points to the historical Ascender Liberation license.
The license text and font sources are available at
https://github.com/liberationfonts/liberation-1.7-fonts (GPL v2:
https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt).
LIBERATION is a trademark of Red Hat, Inc.

The Software is licensed under GNU GPL v2 with the following exceptions:

(a) As a special exception, if you create a document which uses this font, and
embed this font or unaltered portions of this font into the document, this font
does not by itself cause the resulting document to be covered by the GNU General
Public License. This exception does not however invalidate any other reasons why
the document might be covered by the GNU General Public License. If you modify
this font, you may extend this exception to your version of the font, but you
are not obligated to do so. If you do not wish to do so, delete this exception
statement from your version.

(b) As a further exception, any distribution of the object code of the Software
in a physical product must provide you the right to access and modify the source
code for the Software and to reinstall that modified version of the Software in
object code form on the same physical product on which you received it.
