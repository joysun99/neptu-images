variable "IMAGE_NAME" {
  default = "ghcr.io/joysun99/neptu-traefik"
}
variable "REVISION" {
  default = "local"
}
variable "RELEASE_TAG" {
  default = ""
}
variable "SOURCE_URL" {
  default = "https://github.com/joysun99/neptu-images"
}
group "default" {
  targets = ["traefik"]
}
target "traefik" {
  context = "./traefik"
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.source" = SOURCE_URL
    "org.opencontainers.image.revision" = REVISION
  }
  tags = concat(
    ["${IMAGE_NAME}:git-${REVISION}"],
    RELEASE_TAG != "" ? ["${IMAGE_NAME}:${RELEASE_TAG}"] : []
  )
}
