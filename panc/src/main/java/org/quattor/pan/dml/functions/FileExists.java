/*
 Copyright (c) 2006 Charles A. Loomis, Jr, Cedric Duprilot, and
 Centre National de la Recherche Scientifique (CNRS).

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.

 $HeadURL: https://svn.lal.in2p3.fr/LCG/QWG/panc/trunk/src/org/quattor/pan/dml/functions/Format.java $
 $Id: Format.java 2799 2008-01-26 17:10:23Z loomis $
 */

package org.quattor.pan.dml.functions;

import org.quattor.pan.dml.Operation;
import org.quattor.pan.dml.data.BooleanProperty;
import org.quattor.pan.dml.data.Element;
import org.quattor.pan.dml.data.StringProperty;
import org.quattor.pan.exceptions.EvaluationException;
import org.quattor.pan.exceptions.SyntaxException;
import org.quattor.pan.exceptions.SystemException;
import org.quattor.pan.repository.SourceFile;
import org.quattor.pan.ttemplate.Context;
import org.quattor.pan.ttemplate.SourceRange;
import org.quattor.pan.utils.StringUtils;

import java.io.IOException;
import java.io.Reader;

import static org.quattor.pan.utils.MessageUtils.MSG_DIR_NOT_ALLOWED;
import static org.quattor.pan.utils.MessageUtils.MSG_NONEXISTANT_FILE;
import static org.quattor.pan.utils.MessageUtils.MSG_ONE_ARG_REQ;
import static org.quattor.pan.utils.MessageUtils.MSG_RELATIVE_FILE_REQ;

/**
 * Searches for a file on the load path and returns true if the file is found.
 *
 * @author loomis
 *
 */
final public class FileExists extends BuiltInFunction {

    private FileExists(SourceRange sourceRange, Operation... operations)
            throws SyntaxException {
        super("file_exists", sourceRange, operations);

        // There must be exactly one argument.
        if (operations.length != 1) {
            throw SyntaxException.create(sourceRange, MSG_ONE_ARG_REQ,
                    "file_exists");
        }

        // If there is already a fixed argument, then check that it is valid.
        if (operations[0] instanceof Element) {
            String relativePath = verifyRelativePath((Element) operations[0]);
            if (relativePath == null) {
                throw SyntaxException.create(sourceRange,
                        MSG_RELATIVE_FILE_REQ, "file_exists");
            }
        }
    }

    public static Operation getInstance(SourceRange sourceRange,
            Operation... operations) throws SyntaxException {
        return new FileExists(sourceRange, operations);
    }

    @Override
    public Element execute(Context context) {

        throwExceptionIfCompileTimeContext(context);

        // Calculate arguments.
        Element[] args = calculateArgs(context);
        assert (args.length == 1);

        // Get the relative file name to find.
        String relativeFileName = verifyRelativePath(args[0]);
        if (relativeFileName == null) {
            throw EvaluationException.create(sourceRange,
                    MSG_RELATIVE_FILE_REQ, name);
        }

        SourceFile srcFile = context.lookupFile(relativeFileName);

        return BooleanProperty.getInstance(!srcFile.isAbsent());

    }

    private static String verifyRelativePath(Element element) {

        try {

            String name = ((StringProperty) element).getValue();

            // An empty path is not considered a valid relative path. Any path
            // starting with a slash is not relative. (Do NOT use File class to
            // determine an absolute file name because paths starting with a
            // slash are not absolute on windows!)
            if ("".equals(name) || name.startsWith("/")) {
                return null;
            }

            return name;

        } catch (ClassCastException e) {
            return null;
        }

    }

}
