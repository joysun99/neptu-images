variable "REVISION" { default = "local" }
variable "GDS_VERSION" { default = "" }
variable "SOURCE_COMMIT" { default = "" }
variable "SOURCE_TREE" { default = "" }
variable "BINARY_SHA256" { default = "" }
variable "NATIVE_MANIFEST_SHA256" { default = "" }
variable "SOURCE_DATE_EPOCH" { default = "0" }
group "default" { targets = ["gds-device-dispatch"] }
target "gds-device-dispatch" {
  context = "./gds-device-dispatch"
  dockerfile = "Dockerfile"
  target = "runtime"
  platforms = ["linux/amd64"]
  args = {
    GDS_VERSION = GDS_VERSION
    SOURCE_COMMIT = SOURCE_COMMIT
    SOURCE_TREE = SOURCE_TREE
    BINARY_SHA256 = BINARY_SHA256
    NATIVE_MANIFEST_SHA256 = NATIVE_MANIFEST_SHA256
    RECIPE_COMMIT = REVISION
    SOURCE_DATE_EPOCH = SOURCE_DATE_EPOCH
  }
  tags = ["ghcr.io/joysun99/neptu-images:gds-device-dispatch-git-${SOURCE_COMMIT}"]
}
