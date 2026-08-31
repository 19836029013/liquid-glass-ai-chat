package com.dsapp.liquidglasschat.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** P0 回归：更新包 SHA-256 校验（BUG-013 前置）——已知向量、篡改样本、空期望值。 */
public class UpdateVerifierTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File write(String name, String content) throws Exception {
        File file = folder.newFile(name);
        try (Writer writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            writer.write(content);
        }
        return file;
    }

    @Test
    public void sha256MatchesKnownVector() throws Exception {
        File file = write("abc.bin", "abc");
        assertEquals("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
                UpdateVerifier.sha256Hex(file));
    }

    @Test
    public void matchesAcceptsCaseInsensitiveExpected() throws Exception {
        File file = write("case.bin", "abc");
        assertTrue(UpdateVerifier.matches(file,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    }

    @Test
    public void tamperedContentIsRejected() throws Exception {
        File file = write("tamper.bin", "abd");
        assertFalse(UpdateVerifier.matches(file,
                "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"));
    }

    @Test
    public void emptyOrNullExpectedNeverMatches() throws Exception {
        File file = write("null.bin", "abc");
        assertFalse(UpdateVerifier.matches(file, ""));
        assertFalse(UpdateVerifier.matches(file, "   "));
        assertFalse(UpdateVerifier.matches(file, null));
    }
}
