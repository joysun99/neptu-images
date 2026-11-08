variable "IMAGE_NAME" {
  default = "ghcr.io/joysun99/neptu-images"
}
variable "REVISION" {
  default = "local"
}
variable "RELEASE_TAG" {
  default = ""
}
variable "PUBLISH_ALIASES" {
  default = true
}
variable "SOURCE_URL" {
  default = "https://github.com/joysun99/neptu-images"
}

group "default" {
  targets = ["slim", "ffmpeg"]
}

target "common" {
  context = "."
  platforms = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.source" = SOURCE_URL
    "org.opencontainers.image.revision" = REVISION
  }
}

target "slim" {
  inherits = ["common"]
  dockerfile = "node-24/Dockerfile-Slim"
  tags = concat(
    ["${IMAGE_NAME}:node-24-slim-sha-${REVISION}"],
    PUBLISH_ALIASES ? ["${IMAGE_NAME}:node-24-slim"] : [],
    RELEASE_TAG != "" ? ["${IMAGE_NAME}:node-24-slim-${RELEASE_TAG}"] : []
  )
}

target "ffmpeg" {
  inherits = ["common"]
  dockerfile = "node-24/Dockerfile-ffmpeg"
  contexts = {
    runtime-base = "target:slim"
  }
  tags = concat(
    ["${IMAGE_NAME}:node-24-ffmpeg-sha-${REVISION}"],
    PUBLISH_ALIASES ? ["${IMAGE_NAME}:node-24-ffmpeg", "${IMAGE_NAME}:node-24-ffmpeg-7.0.2"] : [],
    RELEASE_TAG != "" ? ["${IMAGE_NAME}:node-24-ffmpeg-${RELEASE_TAG}"] : []
  )
}
