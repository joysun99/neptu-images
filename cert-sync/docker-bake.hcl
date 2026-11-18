variable "IMAGE_NAME" { default = "ghcr.io/joysun99/neptu-cert-sync" }
variable "REVISION" { default = "local" }
variable "RELEASE_TAG" { default = "" }
variable "SOURCE_URL" { default = "https://github.com/joysun99/neptu-images" }
group "default" { targets = ["cert-sync"] }
target "cert-sync" {
  context = "./cert-sync"
  dockerfile = "Dockerfile"
  target = "runtime"
  platforms = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.source" = SOURCE_URL
    "org.opencontainers.image.revision" = REVISION
  }
  tags = concat(["${IMAGE_NAME}:git-${REVISION}"], RELEASE_TAG != "" ? ["${IMAGE_NAME}:${RELEASE_TAG}"] : [])
}
target "cert-sync-test" {
  context = "./cert-sync"
  dockerfile = "Dockerfile"
  target = "test"
  platforms = ["linux/amd64"]
  tags = ["neptu-cert-sync-test:${REVISION}"]
}
