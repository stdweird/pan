package org.quattor.pan.output;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Collections;
import org.junit.Test;
import org.quattor.pan.CompilerOptions;
import org.quattor.pan.tasks.FinalResult;
import org.quattor.pan.tasks.Valid2Result;
import org.quattor.pan.ttemplate.IncludeTrace;
import org.quattor.pan.ttemplate.SourceRange;
import org.quattor.pan.ttemplate.Template;
import static org.junit.Assert.*;

public class DepxFormatterTest {
    @Test
    public void escapesControlsAndPreservesUnicodeAndUnknownMetadata() throws Exception {
        assertEquals("\"é\\r\\t\\u0000\\u007f\"", DepxFormatter.quote("é\r\t\u0000\u007f"));
        assertEquals("null", DepxFormatter.quote(null));
        IncludeTrace.Builder builder = new IncludeTrace.Builder();
        builder.enter(null, null, null, IncludeTrace.Status.EXECUTED);
        FinalResult result = new FinalResult(null, new Valid2Result("unknown", null,
                Collections.<String>emptySet(), null, builder.snapshot()));
        assertTrue(render(result).contains("caller=null target=null caller-path=null target-path=null location=null"));
    }

    @Test
    public void actualDependencyRendererParityAndSeparateSortedProfiles() throws Exception {
        final java.util.List<FinalResult> results = Collections.synchronizedList(new java.util.ArrayList<FinalResult>());
        Formatter capture = new Formatter() {
            public java.net.URI getResultURI(String name) { return java.net.URI.create(name + ".capture"); }
            public String getFormatKey() { return "capture"; }
            public boolean requiresIncludeTrace() { return true; }
            public void write(FinalResult result, java.net.URI uri) { results.add(result); }
        };
        org.quattor.pan.CompilerOptions options = new org.quattor.pan.CompilerOptions(null, null, 100, 50,
                Collections.singleton(capture), org.quattor.pan.utils.TestUtils.getTmpdir(),
                Collections.singletonList(new java.io.File(System.getProperty("panc.testdir"), "depx")),
                CompilerOptions.DeprecationWarnings.OFF, null, null, null, 0);
        org.quattor.pan.CompilerResults compiled = org.quattor.pan.Compiler.run(options,
                Collections.singletonList("trace_context"), Collections.<java.io.File>emptyList());
        assertTrue(compiled.getErrors().toString(), compiled.getErrors().isEmpty());
        FinalResult root = null;
        for (FinalResult result : results) {
            if ("trace_context".equals(result.objectName)) { root = result; }
        }
        assertNotNull(root);
        String text = render(root);
        assertTrue(text.contains("trace_payload.txt"));
        assertTrue(text.indexOf("profile \"trace_context\"") < text.indexOf("profile \"trace_external\""));
        StringWriter dep = new StringWriter();
        DepFormatter.getInstance().write(root, new PrintWriter(dep));
        StringBuilder expected = new StringBuilder("dependencies\n");
        for (String path : dep.toString().split("\\r?\\n")) {
            expected.append("  file ").append(DepxFormatter.quote(path)).append('\n');
        }
        assertEquals(expected.toString(), text.substring(text.indexOf("dependencies\n")));
        for (String line : text.split("\n")) {
            if (line.trim().startsWith("include ") || line.trim().startsWith("create ")) {
                assertFalse(line.contains("-path="));
            }
        }
        assertEquals(text, render(root));
    }

    @Test
    public void registersOptInSingleton() {
        assertSame(DepxFormatter.getInstance(), FormatterUtils.getFormatterInstance("depx"));
        assertTrue(CompilerOptions.getFormatters("depx").contains(DepxFormatter.getInstance()));
        assertTrue(DepxFormatter.getInstance().requiresIncludeTrace());
        assertFalse(DepFormatter.getInstance().requiresIncludeTrace());
        assertTrue(DepxFormatter.getInstance().getResultURI("root").toString().endsWith(".depx"));
    }

    @Test
    public void locksVersionedOrderedGrammarAndEscaping() throws Exception {
        IncludeTrace.Builder builder = new IncludeTrace.Builder();
        Template root = new Template("root");
        Template child = new Template("child");
        builder.enter(root, child, new SourceRange(2, 3, 2, 9), IncludeTrace.Status.EXECUTED);
        builder.enter(child, child, null, IncludeTrace.Status.SKIPPED_UNIQUE);
        builder.leave(0);
        builder.enter(child, child, null, IncludeTrace.Status.SKIPPED_DECLARATION);
        builder.leave(-1);
        builder.enter(root, child, null, IncludeTrace.Status.CREATE);
        FinalResult result = new FinalResult(null, new Valid2Result("root\"\n\\\t", null,
                Collections.<String>emptySet(), null, builder.snapshot()));
        String expected = "depx 1\nprofile \"root\\\"\\n\\\\\\t\"\n"
                + "  site 0 caller=\"root\" target=\"child\" caller-path=null target-path=null location=2.3-2.9\n"
                + "  site 1 caller=\"child\" target=\"child\" caller-path=null target-path=null location=null\n"
                + "  site 2 caller=\"root\" target=\"child\" caller-path=null target-path=null location=null\n"
                + "  occurrences\n"
                + "    include 0 site=0 caller=\"root\" target=\"child\" location=2.3-2.9 status=executed\n"
                + "      include 1 site=1 caller=\"child\" target=\"child\" location=null status=skipped-unique\n"
                + "      include 2 site=1 caller=\"child\" target=\"child\" location=null status=skipped-declaration\n"
                + "    create 3 site=2 caller=\"root\" target=\"child\" location=null status=create\n"
                + "dependencies\n";
        assertEquals(expected, render(result));
        assertEquals(expected, render(result));
    }

    private String render(FinalResult result) throws Exception {
        StringWriter text = new StringWriter();
        DepxFormatter.getInstance().write(result, new PrintWriter(text));
        return text.toString();
    }
}
