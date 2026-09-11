# Pin npm packages by running ./bin/importmap
#
# Three.js is vendored by hand rather than via `bin/importmap pin`: the jspm build splits
# three into chunk files with relative imports, which break once vendored. Instead
# vendor/javascript/three.js is the single-file jsDelivr "+esm" bundle. Addons import the bare
# specifier "three", so vendor each addon file you use and pin it under "three/addons/...":
#
#   curl -sL https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/<path>.js \
#     > vendor/javascript/three--addons--<path with / replaced by -->.js

pin "game"
pin_all_from "app/javascript/game", under: "game"

pin "@rails/actioncable", to: "actioncable.esm.js"

pin "three" # @0.186.0
pin "three/addons/utils/BufferGeometryUtils.js", to: "three--addons--utils--BufferGeometryUtils.js" # @0.186.0
pin "three/addons/loaders/GLTFLoader.js", to: "three--addons--loaders--GLTFLoader.js" # @0.186.0
pin "three/addons/utils/SkeletonUtils.js", to: "three--addons--utils--SkeletonUtils.js" # @0.186.0
pin "three/addons/math/SimplexNoise.js", to: "three--addons--math--SimplexNoise.js" # @0.186.0
pin "three/addons/postprocessing/EffectComposer.js", to: "three--addons--postprocessing--EffectComposer.js" # @0.186.0
pin "three/addons/postprocessing/GTAOPass.js", to: "three--addons--postprocessing--GTAOPass.js" # @0.186.0
pin "three/addons/postprocessing/MaskPass.js", to: "three--addons--postprocessing--MaskPass.js" # @0.186.0
pin "three/addons/postprocessing/OutputPass.js", to: "three--addons--postprocessing--OutputPass.js" # @0.186.0
pin "three/addons/postprocessing/Pass.js", to: "three--addons--postprocessing--Pass.js" # @0.186.0
pin "three/addons/postprocessing/RenderPass.js", to: "three--addons--postprocessing--RenderPass.js" # @0.186.0
pin "three/addons/postprocessing/ShaderPass.js", to: "three--addons--postprocessing--ShaderPass.js" # @0.186.0
pin "three/addons/postprocessing/UnrealBloomPass.js", to: "three--addons--postprocessing--UnrealBloomPass.js" # @0.186.0
pin "three/addons/shaders/CopyShader.js", to: "three--addons--shaders--CopyShader.js" # @0.186.0
pin "three/addons/shaders/GTAOShader.js", to: "three--addons--shaders--GTAOShader.js" # @0.186.0
pin "three/addons/shaders/LuminosityHighPassShader.js", to: "three--addons--shaders--LuminosityHighPassShader.js" # @0.186.0
pin "three/addons/shaders/OutputShader.js", to: "three--addons--shaders--OutputShader.js" # @0.186.0
pin "three/addons/shaders/PoissonDenoiseShader.js", to: "three--addons--shaders--PoissonDenoiseShader.js" # @0.186.0
