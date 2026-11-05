package org.quattor.pan.output;

import java.io.PrintWriter;
import java.io.File;
import java.util.List;
import java.nio.file.Path;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Map;
import java.util.TreeMap;
import org.quattor.pan.repository.SourceFile;
import org.quattor.pan.tasks.FinalResult;
import org.quattor.pan.ttemplate.IncludeTrace;
import org.quattor.pan.ttemplate.Template;

/** Version 2 root-aware runtime include trace with complete file dependencies. */
public class DepxFormatter extends AbstractFormatter {
    private static final DepxFormatter INSTANCE = new DepxFormatter();

    private DepxFormatter() {
        this("depx", "depx");
    }

    protected DepxFormatter(String suffix, String key) {
        super(suffix, key);
    }

    /** Returns the shared formatter. */
    public static DepxFormatter getInstance() {
        return INSTANCE;
    }

    @Override
    public boolean requiresIncludeTrace() {
        return true;
    }

    @Override
    protected void write(FinalResult result, PrintWriter writer) {
        writer.print("depx 2\n");
        List<File> roots = result.getIncludeRoots();
        for (int i = 0; i < roots.size(); i++) {
            writer.print("root " + i + " " + quote(roots.get(i).toString()) + "\n");
        }
        for (Map.Entry<String, IncludeTrace> profile : new TreeMap<String, IncludeTrace>(
                result.getIncludeTraces()).entrySet()) {
            writer.print("profile " + quote(profile.getKey()) + "\n");
            IncludeTrace trace = profile.getValue();
            for (int i = 0; i < trace.getMetadata().size(); i++) {
                IncludeTrace.Metadata site = trace.getMetadata().get(i);
                writer.print("  site " + i + names(site) + " caller-path=" + path(site.caller, roots)
                        + " target-path=" + path(site.target, roots) + " location=" + location(site) + "\n");
            }
            writer.print("  occurrences\n");
            int[] depths = new int[trace.size()];
            for (int i = 0; i < trace.size(); i++) {
                int parent = trace.getParentIndex(i);
                depths[i] = parent < 0 ? 0 : depths[parent] + 1;
                for (int j = 0; j < depths[i] + 2; j++) {
                    writer.print("  ");
                }
                IncludeTrace.Metadata site = trace.getMetadata().get(trace.getMetadataIndex(i));
                String status = trace.getStatus(i).name().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
                writer.print((trace.getStatus(i) == IncludeTrace.Status.CREATE ? "create " : "include ")
                        + i + " site=" + trace.getMetadataIndex(i) + names(site)
                        + " location=" + location(site) + " status=" + status + "\n");
            }
        }
        writer.print("dependencies\n");
        for (SourceFile source : result.getDependencies()) {
            writer.print("  file " + quote(source(source, roots)) + "\n");
        }
    }

    private static String names(IncludeTrace.Metadata site) {
        return " caller=" + quote(site.caller == null ? null : site.caller.name)
                + " target=" + quote(site.target == null ? null : site.target.name);
    }

    private static String path(Template template, List<File> roots) {
        return quote(template == null || template.source == null ? null : source(template.sourceFile, roots));
    }

    /** Compacts only the location URI, retaining source name, type and absence. */
    static String source(SourceFile source, List<File> roots) {
        if (source.getLocation() == null || roots.isEmpty()) {
            return source.toString();
        }
        return source.getName() + " " + source.getType() + " " + compact(source.getLocation(), roots);
    }

    private static String compact(File file, List<File> roots) {
        Path location = file.toPath().normalize();
        for (int i = 0; i < roots.size(); i++) {
            Path root = roots.get(i).toPath().normalize();
            if (location.startsWith(root)) {
                String relative = root.relativize(location).toString().replace(File.separatorChar, '/');
                try {
                    // URI escaping keeps relative Unicode and literal percent signs reversible.
                    String suffix = new URI(null, null, "/" + relative, null).toASCIIString().substring(1);
                    return "//" + (roots.size() == 1 ? "" : i + "//") + suffix;
                } catch (URISyntaxException impossible) {
                    throw new IllegalArgumentException("Cannot encode source location", impossible);
                }
            }
        }
        return file.toURI().toASCIIString();
    }

    private static String location(IncludeTrace.Metadata site) {
        return site.sourceRange == null ? "null" : site.sourceRange.toString();
    }

    /** Quotes text without allowing control characters to introduce records. */
    static String quote(String text) {
        if (text == null) {
            return "null";
        }
        StringBuilder value = new StringBuilder("\"");
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
            case '\\': value.append("\\\\"); break;
            case '"': value.append("\\\""); break;
            case '\n': value.append("\\n"); break;
            case '\r': value.append("\\r"); break;
            case '\t': value.append("\\t"); break;
            default:
                if (Character.isISOControl(c)) {
                    value.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                } else {
                    value.append(c);
                }
            }
        }
        return value.append('"').toString();
    }
}
