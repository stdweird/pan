package org.quattor.pan.output;

import java.io.PrintWriter;
import java.util.Map;
import java.util.TreeMap;
import org.quattor.pan.repository.SourceFile;
import org.quattor.pan.tasks.FinalResult;
import org.quattor.pan.ttemplate.IncludeTrace;
import org.quattor.pan.ttemplate.Template;

/** Version 1 runtime include trace with separate complete file dependencies. */
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
        writer.print("depx 1\n");
        for (Map.Entry<String, IncludeTrace> profile : new TreeMap<String, IncludeTrace>(
                result.getIncludeTraces()).entrySet()) {
            writer.print("profile " + quote(profile.getKey()) + "\n");
            IncludeTrace trace = profile.getValue();
            for (int i = 0; i < trace.getMetadata().size(); i++) {
                IncludeTrace.Metadata site = trace.getMetadata().get(i);
                writer.print("  site " + i + names(site) + " caller-path=" + path(site.caller)
                        + " target-path=" + path(site.target) + " location=" + location(site) + "\n");
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
            writer.print("  file " + quote(source.toString()) + "\n");
        }
    }

    private static String names(IncludeTrace.Metadata site) {
        return " caller=" + quote(site.caller == null ? null : site.caller.name)
                + " target=" + quote(site.target == null ? null : site.target.name);
    }

    private static String path(Template template) {
        return quote(template == null || template.source == null ? null : template.source.toString());
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
