variable "REVISION" { default = "local" }
variable "CERT_VERSION" { default = "" }
variable "SOURCE_COMMIT" { default = "" }
variable "SOURCE_TREE" { default = "" }
variable "BINARY_SHA256" { default = "" }
variable "CANDIDATE_MANIFEST_SHA256" { default = "" }
variable "SOURCE_DATE_EPOCH" { default = "0" }
group "default" { targets = ["cert-sync"] }
target "cert-sync" {
  context = "./cert-sync/go"
  dockerfile = "Dockerfile"
  target = "runtime"
  platforms = ["linux/amd64"]
  args = {
    CERT_VERSION = CERT_VERSION
    SOURCE_COMMIT = SOURCE_COMMIT
    SOURCE_TREE = SOURCE_TREE
    BINARY_SHA256 = BINARY_SHA256
    CANDIDATE_MANIFEST_SHA256 = CANDIDATE_MANIFEST_SHA256
    RECIPE_COMMIT = REVISION
    SOURCE_DATE_EPOCH = SOURCE_DATE_EPOCH
  }
  tags = ["ghcr.io/joysun99/neptu-cert-sync:go-git-${SOURCE_COMMIT}"]
}
