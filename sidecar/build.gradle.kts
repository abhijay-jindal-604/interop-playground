plugins {
  java
  application
  id("com.gradleup.shadow") version "9.4.1"   // highest that loads on Gradle 8.14.3 (S-193); 9.5.0+ need Gradle 9
}

repositories {
  mavenCentral()
  google()                                                      // androidx.annotation, com.android.identity
  maven("https://repo.danubetech.com/repository/maven-public/") // ld-signatures-java, jsonld-common-java (G-27)
  maven("https://jitpack.io") { content { includeGroup("com.github.multiformats") } } // java-multibase
}

dependencyLocking { lockAllConfigurations() }

val vciCoord = "io.inji:inji-vci-client-aar:1.0.0-alpha.1"   // the ONLY hand-written coordinate for vci-client

// 1) fetch the aar and its POM as plain files (no transitive resolution, no classpath use)
val vciAar: Configuration by configurations.creating { isTransitive = false }
val vciPom: Configuration by configurations.creating { isTransitive = false }
dependencies {
  vciAar("$vciCoord@aar")
  vciPom("$vciCoord@pom")
}

// 2) extract classes.jar from the aar
val unpackVciAar by tasks.registering(Copy::class) {
  from(zipTree(vciAar.singleFile)) { include("classes.jar") }
  into(layout.buildDirectory.dir("vci-aar"))
}

// 3) derive runtime deps from the aar's POM; swap the aar sibling for its jar (S-192)
val pomDeps: List<String> = run {
  val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(vciPom.singleFile)
  val deps = (doc.documentElement.getElementsByTagName("dependencies").item(0) as org.w3c.dom.Element).getElementsByTagName("dependency")
  (0 until deps.length).map { i ->
    val d = deps.item(i) as org.w3c.dom.Element
    fun t(n: String) = d.getElementsByTagName(n).item(0).textContent.trim()
    "${t("groupId")}:${t("artifactId").replace("-aar", "-jar")}:${t("version")}"
  }
}
tasks.register("printPomDeps") { doLast { pomDeps.forEach(::println) } }

dependencies {
  implementation(files(unpackVciAar.map { it.destinationDir.resolve("classes.jar") }).builtBy(unpackVciAar))
  pomDeps.forEach { implementation(it) }
  implementation("io.inji:vcverifier-jar:1.9.0")        // wins over openid4vp-jar's 1.8.1 (highest-wins)
  implementation("io.inji:pixelpass-jar:1.0.0-alpha.1")
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
application { mainClass = "Sidecar" }

tasks.named<JavaExec>("run") {
  System.getProperty("mintBase")?.let { systemProperty("mintBase", it) }
}
tasks.register("printCp") { doLast { println(sourceSets["main"].runtimeClasspath.asPath) } }

// Dedup excludes are always on (S-193: 0 duplicate classes except module-info.class)
configurations.matching { it.name in setOf("implementation", "runtimeClasspath", "compileClasspath") }.configureEach {
  exclude(group = "org.bouncycastle", module = "bcprov-jdk15on")
  exclude(group = "org.bouncycastle", module = "bcpkix-jdk15on")
  exclude(group = "org.bouncycastle", module = "bcutil-jdk15on")
  exclude(group = "org.bouncycastle", module = "bcprov-jdk15to18")
  exclude(group = "com.google.protobuf", module = "protobuf-javalite")
  exclude(group = "com.apicatalog", module = "titanium-json-ld-jre8")
  exclude(group = "androidx.annotation", module = "annotation")
}
tasks.shadowJar { mergeServiceFiles() }
