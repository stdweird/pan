package org.quattor.pan.output;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPOutputStream;

/** Gzip-compressed UTF-8 structured runtime trace. */
public class DepxJsonGzipFormatter extends DepxJsonFormatter {
    private static final DepxJsonGzipFormatter INSTANCE = new DepxJsonGzipFormatter();

    private DepxJsonGzipFormatter() {
        super("depx.json.gz", "depx.json.gz");
    }

    /** Returns the shared compressed JSON formatter. */
    public static DepxJsonGzipFormatter getInstance() {
        return INSTANCE;
    }

    @Override
    protected PrintWriter getPrintWriter(File file) throws Exception {
        return new PrintWriter(new OutputStreamWriter(new GZIPOutputStream(new FileOutputStream(file)),
                StandardCharsets.UTF_8));
    }
}
