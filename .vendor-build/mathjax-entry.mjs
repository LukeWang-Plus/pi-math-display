// One-time bundle entry. Every TeX configuration is imported explicitly so
// excluded packages cannot enter through AllPackages side effects.
import { mathjax } from "mathjax-full/js/mathjax.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { SafeHandler } from "mathjax-full/js/ui/safe/SafeHandler.js";

import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/action/ActionConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/amscd/AmsCdConfiguration.js";
import "mathjax-full/js/input/tex/bbox/BboxConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/braket/BraketConfiguration.js";
import "mathjax-full/js/input/tex/bussproofs/BussproofsConfiguration.js";
import "mathjax-full/js/input/tex/cancel/CancelConfiguration.js";
import "mathjax-full/js/input/tex/cases/CasesConfiguration.js";
import "mathjax-full/js/input/tex/centernot/CenternotConfiguration.js";
import "mathjax-full/js/input/tex/color/ColorConfiguration.js";
import "mathjax-full/js/input/tex/colortbl/ColortblConfiguration.js";
import "mathjax-full/js/input/tex/empheq/EmpheqConfiguration.js";
import "mathjax-full/js/input/tex/enclose/EncloseConfiguration.js";
import "mathjax-full/js/input/tex/extpfeil/ExtpfeilConfiguration.js";
import "mathjax-full/js/input/tex/gensymb/GensymbConfiguration.js";
import "mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/upgreek/UpgreekConfiguration.js";
import "mathjax-full/js/input/tex/unicode/UnicodeConfiguration.js";
import "mathjax-full/js/input/tex/verb/VerbConfiguration.js";
import "mathjax-full/js/input/tex/tagformat/TagFormatConfiguration.js";
import "mathjax-full/js/input/tex/textcomp/TextcompConfiguration.js";
import "mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js";

// Bundled for future opt-in, but intentionally absent from DEFAULT_TEX_PACKAGES.
import "mathjax-full/js/input/tex/physics/PhysicsConfiguration.js";
import "mathjax-full/js/input/tex/colorv2/ColorV2Configuration.js";
import "mathjax-full/js/input/tex/setoptions/SetOptionsConfiguration.js";

const DEFAULT_TEX_PACKAGES = Object.freeze([
  "base",
  "action",
  "ams",
  "amscd",
  "bbox",
  "boldsymbol",
  "braket",
  "bussproofs",
  "cancel",
  "cases",
  "centernot",
  "color",
  "colortbl",
  "empheq",
  "enclose",
  "extpfeil",
  "gensymb",
  "mathtools",
  "mhchem",
  "newcommand",
  "upgreek",
  "unicode",
  "verb",
  "tagformat",
  "textcomp",
  "textmacros",
]);

const OPTIONAL_TEX_PACKAGES = Object.freeze(["physics", "colorv2", "setoptions"]);

export {
  DEFAULT_TEX_PACKAGES,
  OPTIONAL_TEX_PACKAGES,
  mathjax,
  liteAdaptor,
  RegisterHTMLHandler,
  TeX,
  SVG,
  SafeHandler,
};
