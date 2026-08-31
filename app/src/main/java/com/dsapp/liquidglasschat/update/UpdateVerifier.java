package com.dsapp.liquidglasschat.update;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * P0（BUG-013 前置）：更新包 SHA-256 校验。
 * 纯静态工具，便于 JVM 单元测试覆盖已知向量与篡改样例。
 */
public final class UpdateVerifier {
    private UpdateVerifier() {
    }

    /** 流式计算文件 SHA-256，返回大写十六进制。 */
    public static String sha256Hex(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IOException("设备不支持 SHA-256", error);
        }
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        byte[] bytes = digest.digest();
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            hex.append(Character.forDigit((value >> 4) & 0xF, 16));
            hex.append(Character.forDigit(value & 0xF, 16));
        }
        return hex.toString().toUpperCase(Locale.US);
    }

    /** 与期望值比对（大小写不敏感）；期望值为空一律视为不匹配。 */
    public static boolean matches(File file, String expectedHex) throws IOException {
        if (expectedHex == null || expectedHex.trim().isEmpty()) return false;
        return sha256Hex(file).equals(expectedHex.trim().toUpperCase(Locale.US));
    }
}
